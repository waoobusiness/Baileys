import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import pino from 'pino'
import QRCode from 'qrcode'
import { Boom } from '@hapi/boom'
import {
  BufferJSON,
  makeWASocket,
  proto,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'

const logger = pino({ level: 'info', base: { app: process.env.APP_NAME || 'Zuria.AI' } })
const PORT = Number(process.env.PORT || 10000)
const AUTH_DIR = process.env.AUTH_DIR || '.baileys_auth'
const TOKENS = (process.env.TOKENS || '').split(',').map(s => s.trim()).filter(Boolean)
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1'

function authOk(req: express.Request) {
  if (AUTH_DISABLED || TOKENS.length === 0) return true
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim()
  const xKey = String(req.headers['x-api-key'] || '').trim()
  if (!auth && !xKey) return false
  return TOKENS.includes(auth || xKey)
}
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized' })
  next()
}

type SessionStatus = 'idle' | 'qr' | 'connecting' | 'connected' | 'closed' | 'error'
type SseClient = { id: string; res: express.Response }
type Session = {
  id: string
  status: SessionStatus
  lastQr?: string
  lastJid?: string
  sock?: ReturnType<typeof makeWASocket>
  sseClients: SseClient[]
  webhookUrl?: string
  webhookSecret?: string
  closing?: boolean
}
const sessions = new Map<string, Session>()

function normalizeToJid(to: string) {
  const v = String(to || '').trim()
  if (!v) throw new Error('missing "to"')
  return v.includes('@') ? v : `${v}@s.whatsapp.net`
}
async function fetchAsBuffer(url: string): Promise<Buffer> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`download_failed:${r.status}`)
  const ab = await r.arrayBuffer()
  return Buffer.from(ab)
}
function emitSse(sess: Session, event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of [...sess.sseClients]) {
    try { c.res.write(payload) } catch {
      const idx = sess.sseClients.findIndex(s => s.id === c.id)
      if (idx >= 0) sess.sseClients.splice(idx, 1)
    }
  }
}
async function postWebhook(sess: Session, body: any) {
  if (!sess.webhookUrl) return
  try {
    const r = await fetch(sess.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(sess.webhookSecret ? { 'x-webhook-secret': sess.webhookSecret } : {}),
      },
      body: JSON.stringify(body),
    })
    if (!r.ok) logger.warn({ session: sess.id, status: r.status }, 'webhook non-200')
  } catch (e) {
    logger.warn({ session: sess.id, err: String(e) }, 'webhook error')
  }
}
async function waitConnected(sess: Session, timeoutMs = 8000) {
  if (sess.status === 'connected') return true
  const start = Date.now()
  return new Promise<boolean>((resolve) => {
    const iv = setInterval(() => {
      if (sess.status === 'connected') { clearInterval(iv); resolve(true) }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); resolve(false) }
    }, 200)
  })
}

async function ensureSession(id: string): Promise<Session> {
  const existing = sessions.get(id)
  if (existing?.sock) return existing

  const { state, saveCreds } = await useMultiFileAuthState(`${AUTH_DIR}/${id}`)
  const { version } = await fetchLatestBaileysVersion()

  const sess: Session = { id, status: 'idle', sseClients: [] }
  sessions.set(id, sess)

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: [process.env.APP_NAME || 'Zuria.AI', 'Chrome', '121'],
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
  })
  sess.sock = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      sess.status = 'qr'
      sess.lastQr = await QRCode.toDataURL(qr, { margin: 0, scale: 6 })
      emitSse(sess, 'qr', { session_id: id, qr: sess.lastQr })
      await postWebhook(sess, { event: 'session.status', session_id: id, status: 'qr' })
    }
    if (connection === 'connecting') {
      sess.status = 'connecting'
      emitSse(sess, 'status', { session_id: id, status: 'connecting' })
      await postWebhook(sess, { event: 'session.status', session_id: id, status: 'connecting' })
    }
    if (connection === 'open') {
      sess.status = 'connected'
      emitSse(sess, 'connected', { session_id: id })
      await postWebhook(sess, { event: 'session.status', session_id: id, status: 'connected' })
    }
    if (connection === 'close') {
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode
      sess.status = 'closed'
      emitSse(sess, 'closed', { session_id: id, reason })
      await postWebhook(sess, { event: 'session.status', session_id: id, status: 'closed', reason })
      if (!sess.closing && reason !== DisconnectReason.loggedOut) {
        logger.info({ id }, 'restarting socket after close')
        setTimeout(() => ensureSession(id).catch(() => {}), 800)
      }
    }
  })

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages?.[0]
    if (!msg) return
    const from = msg.key.remoteJid
    const isMe = !!msg.key.fromMe
    if (isMe) await postWebhook(sess, { event: 'message.outgoing', session_id: id, jid: from, message: msg })
    else     await postWebhook(sess, { event: 'message.incoming', session_id: id, jid: from, message: msg })
  })

  return sess
}

async function closeSession(id: string, logout = true) {
  const sess = sessions.get(id)
  if (!sess) return
  sess.closing = true
  try { if (logout && sess.sock?.logout) await sess.sock.logout() } catch {}
  try { sess.sock?.end(undefined) } catch {}
  sessions.delete(id)
}

const app = express()
app.disable('x-powered-by')
app.use(cors({ origin: true }))
app.use(express.json({ limit: '15mb' }))

app.get('/health', (_req, res) => res.json({ ok: true }))

app.get('/sessions', requireAuth, (_req, res) => {
  const all = [...sessions.values()].map(s => ({
    id: s.id, status: s.status, lastJid: s.lastJid, sseClients: s.sseClients.length
  }))
  res.json({ ok: true, sessions: all })
})

app.get('/sessions/:id/status', requireAuth, async (req, res) => {
  const id = req.params.id
  const sess = await ensureSession(id)
  res.json({ ok: true, session_id: id, status: sess.status, has_qr: !!sess.lastQr })
})

app.post('/sessions/:id/start', requireAuth, async (req, res) => {
  const id = req.params.id
  const { webhookUrl, webhookSecret } = req.body || {}
  const sess = await ensureSession(id)
  if (webhookUrl) sess.webhookUrl = webhookUrl
  if (webhookSecret) sess.webhookSecret = webhookSecret
  res.json({ ok: true, session_id: id, status: sess.status, has_qr: !!sess.lastQr })
})

app.get('/sessions/:id/sse', requireAuth, async (req, res) => {
  const id = req.params.id
  const sess = await ensureSession(id)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const client: SseClient = { id: Math.random().toString(36).slice(2), res }
  sess.sseClients.push(client)
  if (sess.status === 'qr' && sess.lastQr) emitSse(sess, 'qr', { session_id: id, qr: sess.lastQr })
  else emitSse(sess, 'status', { session_id: id, status: sess.status })
  req.on('close', () => {
    const idx = sess.sseClients.findIndex(s => s.id === client.id)
    if (idx >= 0) sess.sseClients.splice(idx, 1)
  })
})

app.post('/sessions/:id/reset', requireAuth, async (req, res) => {
  const id = req.params.id
  await closeSession(id, true)
  const sess = await ensureSession(id)
  res.json({ ok: true, session_id: id, status: sess.status })
})

app.post('/sessions/:id/disconnect', requireAuth, async (req, res) => {
  const id = req.params.id
  await closeSession(id, true)
  res.json({ ok: true, session_id: id })
})

app.post('/sessions/:id/messages', requireAuth, async (req, res) => {
  const id = req.params.id
  const { to, type } = req.body || {}
  try {
    if (!to) return res.status(400).json({ ok: false, error: 'missing_to' })
    if (!type) return res.status(400).json({ ok: false, error: 'missing_type' })

    const sess = await ensureSession(id)

    // Attente courte si la socket vient d'être relancée
    if (sess.status !== 'connected') {
      const ok = await waitConnected(sess, 8000)
      if (!ok || !sess.sock) return res.status(409).json({ ok: false, error: 'not_connected' })
    }

    const jid = normalizeToJid(to)
    let result: proto.WebMessageInfo | undefined

    if (type === 'text') {
      const text = String(req.body.text || '').trim()
      if (!text) return res.status(400).json({ ok: false, error: 'missing_text' })
      result = await sess.sock!.sendMessage(jid, { text })
    } else if (type === 'image') {
      const { url, base64, caption } = req.body || {}
      let media: Buffer | undefined
      if (base64) media = Buffer.from(String(base64), 'base64')
      else if (url) media = await fetchAsBuffer(String(url))
      if (!media) return res.status(400).json({ ok: false, error: 'missing_media' })
      result = await sess.sock!.sendMessage(jid, { image: media, caption: caption || undefined })
    } else if (type === 'audio') {
      const { url, base64, ptt } = req.body || {}
      let media: Buffer | undefined
      if (base64) media = Buffer.from(String(base64), 'base64')
      else if (url) media = await fetchAsBuffer(String(url))
      if (!media) return res.status(400).json({ ok: false, error: 'missing_media' })
      result = await sess.sock!.sendMessage(jid, { audio: media, ptt: !!ptt })
    } else {
      return res.status(400).json({ ok: false, error: 'unsupported_type' })
    }

    return res.json({ ok: true, session_id: id, to: jid, key: result?.key || null })
  } catch (e: any) {
    logger.error({ err: String(e) }, 'send_message_error')
    return res.status(502).json({ ok: false, error: 'gateway_send_failed', detail: String(e) })
  }
})

app.listen(PORT, () => {
  logger.info({ port: PORT, authDir: AUTH_DIR }, 'Gateway listening')
})
