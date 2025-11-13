import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import pino from 'pino'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  WASocket,
  WAMessage,
} from '@whiskeysockets/baileys'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const logger = pino({ level: 'info' })
const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))

const PORT = Number(process.env.PORT || 10000)
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''
const AUTH_DIR = process.env.AUTH_DIR || '.baileys_auth'
const WEBHOOK_BASE = (process.env.WEBHOOK_BASE || '').replace(/\/+$/, '')
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''
const BROWSER_NAME = process.env.BROWSER_NAME || 'Zuria.AI'

if (!AUTH_TOKEN) logger.warn('AUTH_TOKEN is empty; set a strong token!')
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true })

// --------- Auth middleware ----------
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const h = req.headers['authorization'] || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (!AUTH_TOKEN || token !== AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }
  next()
}

// --------- Session store (in-memory) ----------
type SseClient = { id: string; res: express.Response }
type Session = {
  id: string
  sock?: WASocket
  sse: Map<string, SseClient>
  webhookUrl?: string
  webhookSecret?: string
  connected: boolean
}
const sessions = new Map<string, Session>()

function getSession(id: string) {
  let s = sessions.get(id)
  if (!s) {
    s = { id, sse: new Map(), connected: false }
    sessions.set(id, s)
  }
  return s
}

// --------- Helpers ----------
async function sendWebhook(session: Session, payload: any) {
  try {
    if (!session.webhookUrl || !WEBHOOK_BASE) return
    await fetch(session.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': session.webhookSecret || WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    logger.warn({ msg: 'webhook failed', id: session.id, error: String(e) })
  }
}

function sseSend(session: Session, event: string, data: any) {
  session.sse.forEach(({ res }) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  })
}

async function rmrf(dir: string) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true })
  } catch { /* no-op */ }
}

function normalizeJid(to: string): string {
  return to.includes('@') ? to : `${to}@s.whatsapp.net`
}

// --------- Start Baileys session ----------
async function startSession(id: string, opts?: { webhookUrl?: string; webhookSecret?: string }) {
  const session = getSession(id)
  if (opts?.webhookUrl) session.webhookUrl = opts.webhookUrl
  if (opts?.webhookSecret) session.webhookSecret = opts.webhookSecret

  const dir = path.join(AUTH_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(dir)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS(BROWSER_NAME),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  })
  session.sock = sock

  sock.ev.on('creds.update', saveCreds)

  // Connection updates (QR, status, errors)
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      // Envoyer le QR sous forme dataURL (lisible direct par le frontend)
      const dataUrl = await QRCode.toDataURL(qr, { margin: 0 })
      sseSend(session, 'qr', { session_id: id, qrData: dataUrl })
      // Et notifier le webhook (utile pour Supabase)
      await sendWebhook(session, { event: 'session.status', session_id: id, status: 'qr' })
    }

    if (connection === 'open') {
      session.connected = true
      sseSend(session, 'status', { session_id: id, status: 'connected' })
      await sendWebhook(session, { event: 'session.status', session_id: id, status: 'connected' })
      logger.info({ app: BROWSER_NAME, id, msg: 'connected to WA' })
    }

    if (connection === 'close') {
      session.connected = false
      const reason = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      sseSend(session, 'status', { session_id: id, status: 'closed', reason })
      await sendWebhook(session, { event: 'session.status', session_id: id, status: 'closed', reason })
      const shouldReconnect = reason !== DisconnectReason.loggedOut
      logger.info({ app: BROWSER_NAME, id, reason, msg: 'socket closed' })
      if (shouldReconnect) {
        logger.info({ app: BROWSER_NAME, id, msg: 'restarting socket after close' })
        startSession(id, opts).catch(() => {})
      }
    }

    if (connection === 'connecting') {
      sseSend(session, 'status', { session_id: id, status: 'connecting' })
      await sendWebhook(session, { event: 'session.status', session_id: id, status: 'connecting' })
    }
  })

  // Incoming messages
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return
    for (const msg of m.messages as WAMessage[]) {
      const from = msg.key.remoteJid || ''
      const isMe = !!msg.key.fromMe
      const text =
        (msg.message?.conversation) ||
        (msg.message?.extendedTextMessage?.text) ||
        (msg.message?.imageMessage?.caption) ||
        ''
      const payload = {
        event: isMe ? 'message.outgoing' : 'message.incoming',
        session_id: id,
        from,
        message: { text },
        timestamp: Date.now()
      }
      await sendWebhook(session, payload)

      // Auto-détection “connected” si le gateway de l’autre côté n’envoie pas l’event
      if (!session.connected) {
        session.connected = true
        sseSend(session, 'status', { session_id: id, status: 'connected' })
        await sendWebhook(session, { event: 'session.status', session_id: id, status: 'connected' })
      }
    }
  })

  return session
}

// ---------- HTTP endpoints ----------
app.get('/health', (_req, res) => res.json({ ok: true }))

// Start pairing / keep-alive QR via SSE
app.post('/sessions/:id/start', requireAuth, async (req, res) => {
  try {
    const id = req.params.id
    const { webhookUrl, webhookSecret } = req.body || {}
    await startSession(id, { webhookUrl: webhookUrl || `${WEBHOOK_BASE}`, webhookSecret: webhookSecret || WEBHOOK_SECRET })
    return res.json({ ok: true, session_id: id })
  } catch (e) {
    logger.error({ err: String(e) })
    return res.status(500).json({ ok: false, error: 'start_failed' })
  }
})

// Force reset (logout + purge auth files)
app.post('/sessions/:id/reset', requireAuth, async (req, res) => {
  const id = req.params.id
  try {
    const s = sessions.get(id)
    if (s?.sock) {
      try { await s.sock.logout() } catch { /* ignore */ }
    }
    sessions.delete(id)
    await rmrf(path.join(AUTH_DIR, id))
    sseSend({ id, sse: new Map(), connected: false }, 'status', { session_id: id, status: 'reset' })
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'reset_failed' })
  }
})

// SSE for QR + status
app.get('/sessions/:id/sse', requireAuth, async (req, res) => {
  const id = req.params.id
  const s = getSession(id)

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const clientId = Math.random().toString(36).slice(2)
  s.sse.set(clientId, { id: clientId, res })
  res.write(`event: status\ndata: ${JSON.stringify({ session_id: id, status: s.connected ? 'connected' : 'connecting' })}\n\n`)

  req.on('close', () => {
    s.sse.delete(clientId)
  })
})

// Status check
app.get('/sessions/:id/status', requireAuth, (req, res) => {
  const id = req.params.id
  const s = getSession(id)
  return res.json({ ok: true, session_id: id, connected: !!s.connected })
})

// SEND: unified endpoint (text / image / audio)
app.post('/sessions/:id/messages', requireAuth, async (req, res) => {
  const id = req.params.id
  const { to, type, text, mediaUrl, ptt } = req.body || {}
  if (!to || !type) return res.status(400).json({ ok: false, error: 'bad_request' })

  const s = getSession(id)
  const sock = s.sock
  if (!sock) return res.status(409).json({ ok: false, error: 'not_connected' })

  const jid = normalizeJid(String(to))
  try {
    if (type === 'text') {
      await sock.sendMessage(jid, { text: String(text ?? '') })
    } else if (type === 'image') {
      if (!mediaUrl) return res.status(400).json({ ok: false, error: 'mediaUrl_required' })
      const buf = Buffer.from(await (await fetch(mediaUrl)).arrayBuffer())
      await sock.sendMessage(jid, { image: buf, caption: String(text ?? '') })
    } else if (type === 'audio') {
      if (!mediaUrl) return res.status(400).json({ ok: false, error: 'mediaUrl_required' })
      const buf = Buffer.from(await (await fetch(mediaUrl)).arrayBuffer())
      await sock.sendMessage(jid, { audio: buf, ptt: !!ptt })
    } else {
      return res.status(400).json({ ok: false, error: 'unsupported_type' })
    }
    return res.json({ ok: true })
  } catch (e) {
    const boom = e as Boom
    const code = (boom as any)?.output?.statusCode || 500
    logger.error({ id, to: jid, type, err: String(e) })
    return res.status(502).json({ ok: false, error: 'gateway_send_failed', status: code })
  }
})

// Compatibility aliases (try your older probes)
app.post('/sessions/:id/sendText', requireAuth, (req, res) => {
  req.body.type = 'text'
  app._router.handle(req, res, () => {}, 'post', `/sessions/${req.params.id}/messages`)
})
app.post('/sessions/:id/sendMessage', requireAuth, (req, res) => {
  // accept { to, text } as text
  req.body.type = req.body.type || (req.body.text ? 'text' : undefined)
  app._router.handle(req, res, () => {}, 'post', `/sessions/${req.params.id}/messages`)
})
app.post('/sessions/:id/messages/text', requireAuth, (req, res) => {
  req.body.type = 'text'
  app._router.handle(req, res, () => {}, 'post', `/sessions/${req.params.id}/messages`)
})
app.post('/sessions/:id/message', requireAuth, (req, res) => {
  // generic
  app._router.handle(req, res, () => {}, 'post', `/sessions/${req.params.id}/messages`)
})

app.listen(PORT, () => {
  logger.info({ app: BROWSER_NAME, port: PORT, authDir: AUTH_DIR, msg: 'Gateway listening' })
})
