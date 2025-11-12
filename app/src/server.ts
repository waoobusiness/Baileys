import express, { Request, Response } from 'express'
import cors from 'cors'
import pino from 'pino'
import pinoHttp from 'pino-http'
import { Boom } from '@hapi/boom'
import {
  proto,
  WASocket,
  DisconnectReason,
  makeWASocket,
  Browsers,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import fetch from 'node-fetch'
import http from 'http'

// ---------- Config ----------
const PORT = Number(process.env.PORT || 10000)
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data', 'wa-auth')
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''           // si vide -> pas d’auth
const AUTO_DOWNLOAD_MEDIA = process.env.AUTO_DOWNLOAD_MEDIA === '1'

fs.mkdirSync(DATA_DIR, { recursive: true })

// ---------- Logger ----------
const logger = pino({ level: LOG_LEVEL })
const httpLogger = pinoHttp({
  logger,
  customProps: (req) => ({ path: req.url, method: req.method })
})

// ---------- Helpers ----------
function requireAuth(req: Request, res: Response): boolean {
  if (!AUTH_TOKEN) return true
  const header = req.header('authorization') || ''
  const xApiKey = req.header('x-api-key') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : header
  const ok = token === AUTH_TOKEN || xApiKey === AUTH_TOKEN
  if (!ok) res.status(403).json({ ok: false, error: 'forbidden' })
  return ok
}

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  }
}

function sendSse(res: Response, event: string, data: any) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function jidToPhone(jid?: string | null) {
  if (!jid) return null
  const m = jid.match(/^(\d+):?\d*@s\.whatsapp\.net$/)
  return m ? m[1] : null
}

function toJid(to: string) {
  return to.includes('@') ? to : `${to}@s.whatsapp.net`
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ---------- Session Store ----------
type WebhookCfg = { url?: string, secret?: string }
type SseClient = { id: string, res: Response, heartbeat: NodeJS.Timeout }

type SessionState = {
  id: string
  sock?: WASocket
  status: 'idle'|'qr'|'connecting'|'open'|'close'|'error'
  lastQr?: string
  webhook: WebhookCfg
  sse: Map<string, SseClient>
  createdAt: number
  connectedAt?: number
}

const sessions = new Map<string, SessionState>()

function sessionPath(id: string) {
  return path.join(DATA_DIR, 'sessions', id)
}

async function createOrGetSession(id: string, webhook?: WebhookCfg): Promise<SessionState> {
  let st = sessions.get(id)
  if (st) {
    if (webhook) st.webhook = webhook
    return st
  }
  fs.mkdirSync(sessionPath(id), { recursive: true })
  st = {
    id,
    status: 'idle',
    webhook: webhook || {},
    sse: new Map(),
    createdAt: Date.now()
  }
  sessions.set(id, st)
  return st
}

async function startSession(st: SessionState) {
  const authDir = sessionPath(st.id)
  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()

  st.status = 'connecting'

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    browser: Browsers.macOS('Zuria.AI'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true
  })

  st.sock = sock

  // connection & QR updates
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u as any
    if (qr) {
      st.lastQr = qr
      st.status = 'qr'
      broadcast(st, 'qr', { session_id: st.id, qr })
      await postWebhook(st, 'session.status', { status: 'qr', session_id: st.id })
    }
    if (connection === 'connecting') {
      st.status = 'connecting'
      broadcast(st, 'status', { session_id: st.id, status: 'connecting' })
      await postWebhook(st, 'session.status', { status: 'connecting', session_id: st.id })
    }
    if (connection === 'open') {
      st.status = 'open'
      st.connectedAt = Date.now()
      broadcast(st, 'status', { session_id: st.id, status: 'open' })
      await postWebhook(st, 'session.status', { status: 'open', session_id: st.id })
    }
    if (connection === 'close') {
      const err = (lastDisconnect?.error as Boom | undefined)
      const code = (err?.output?.statusCode || 0) as number
      st.status = 'close'
      broadcast(st, 'status', { session_id: st.id, status: 'close', code })
      await postWebhook(st, 'session.status', { status: 'close', session_id: st.id, code })
      // auto-restart soft
      await sleep(1200)
      startSession(st).catch(e => logger.error({ e }, 'restart failed'))
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // messages
  sock.ev.on('messages.upsert', async m => {
    const up = m as any
    if (up.type !== 'notify') return
    for (const msg of up.messages as proto.IWebMessageInfo[]) {
      const fromMe = !!msg.key?.fromMe
      const jid = (msg.key?.remoteJid || '') as string
      const phone = jidToPhone(jid)
      const id = msg.key?.id
      const ts = Number(msg.messageTimestamp || Date.now()/1000) * 1000

      const payload: any = {
        session_id: st.id,
        direction: fromMe ? 'outgoing' : 'incoming',
        jid,
        phone,
        message_id: id,
        timestamp: ts,
        message: normalizeMessage(msg)
      }
      // enrich (best-effort)
      try {
        payload.profile = {
          name: (sock?.contacts?.[jid]?.notify) || undefined
        }
        try { payload.profile.photoUrl = await sock?.profilePictureUrl(jid, 'image') as string } catch {}
      } catch {}

      broadcast(st, 'message', payload)
      await postWebhook(st, `message.${fromMe ? 'outgoing' : 'incoming'}`, payload)
    }
  })

  // receipts (optional)
  sock.ev.on('messages.update', async updates => {
    for (const u of updates) {
      const jid = u.key?.remoteJid
      const id = u.key?.id
      const status = u.update?.status
      const payload = { session_id: st.id, jid, id, status }
      broadcast(st, 'receipt', payload)
      await postWebhook(st, 'message.status', payload)
    }
  })
}

function normalizeMessage(msg: proto.IWebMessageInfo) {
  const m = msg.message
  if (!m) return { type: 'unknown' }
  if (m.conversation) return { type: 'text', text: m.conversation }
  if (m.extendedTextMessage?.text) return { type: 'text', text: m.extendedTextMessage.text }
  if (m.imageMessage) {
    return { type: 'image', caption: m.imageMessage.caption, mimeType: m.imageMessage.mimetype }
  }
  if (m.audioMessage) {
    return { type: 'audio', ptt: !!m.audioMessage.ptt, mimeType: m.audioMessage.mimetype, seconds: m.audioMessage.seconds }
  }
  if (m.documentMessage) return { type: 'document', fileName: m.documentMessage.fileName, mimeType: m.documentMessage.mimetype }
  if (m.stickerMessage) return { type: 'sticker' }
  return { type: 'unknown' }
}

function broadcast(st: SessionState, event: string, data: any) {
  for (const [id, c] of st.sse.entries()) {
    try { sendSse(c.res, event, data) } catch (e) { logger.warn({ id, e }, 'sse send failed') }
  }
}

async function postWebhook(st: SessionState, event: string, data: any) {
  if (!st.webhook?.url) return
  try {
    await fetch(st.webhook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': st.webhook.secret || ''
      },
      body: JSON.stringify({ event, ...data })
    })
  } catch (e) {
    logger.warn({ e, url: st.webhook.url }, 'webhook post failed')
  }
}

async function ensureConnected(st: SessionState) {
  if (st.status === 'open' && st.sock) return
  const err: any = new Error('not_connected'); err.status = 409; throw err
}

// ---------- HTTP Server ----------
const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(httpLogger)

// health
app.get('/health', (req, res) => res.status(200).json({ ok: true, status: 'up', time: Date.now() }))

// Start a session (called by Supabase wa-register)
app.post('/sessions/:id/start', async (req, res) => {
  if (!requireAuth(req, res)) return
  const id = req.params.id
  const { webhookUrl, webhookSecret } = req.body || {}

  const st = await createOrGetSession(id, { url: webhookUrl, secret: webhookSecret })
  if (st.sock) {
    // déjà lancé → renvoi statut instant
    broadcast(st, 'status', { session_id: id, status: st.status })
    return res.json({ ok: true, session_id: id, started: true, status: st.status })
  }
  startSession(st).catch(e => logger.error({ e }, 'startSession failed'))
  res.json({ ok: true, session_id: id, started: true })
})

// Reset: supprime l’auth et redémarre clean
app.post('/sessions/:id/reset', async (req, res) => {
  if (!requireAuth(req, res)) return
  const id = req.params.id
  const st = await createOrGetSession(id)
  try {
    const dir = sessionPath(id)
    fs.rmSync(dir, { recursive: true, force: true })
    st.sock?.end(undefined)
    sessions.delete(id)
  } catch (e) {
    logger.warn({ e }, 'reset failed')
  }
  res.json({ ok: true, reset: true })
})

// SSE pour QR + status + messages
app.get('/sessions/:id/events', async (req, res) => {
  if (!requireAuth(req, res)) return
  const id = req.params.id
  const st = await createOrGetSession(id)
  res.writeHead(200, sseHeaders())

  const cid = crypto.randomUUID()
  const heartbeat = setInterval(() => { try { res.write(':\n\n') } catch {} }, 15000)
  st.sse.set(cid, { id: cid, res, heartbeat })

  // push immédiat
  sendSse(res, 'status', { session_id: id, status: st.status })
  if (st.lastQr) sendSse(res, 'qr', { session_id: id, qr: st.lastQr })

  req.on('close', () => { clearInterval(heartbeat); st.sse.delete(cid) })
})

// ENVOI multi-type: texte / image / audio(PTT)
app.post('/sessions/:id/messages', async (req, res) => {
  if (!requireAuth(req, res)) return
  const id = req.params.id
  const st = await createOrGetSession(id)
  try { await ensureConnected(st) } catch (e: any) {
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'not_connected' })
  }

  const { to, type, text, mediaUrl, ptt, caption } = req.body || {}
  if (!to) return res.status(400).json({ ok: false, error: 'missing_to' })
  const jid = toJid(String(to))

  try {
    if (type === 'text') {
      await st.sock!.sendMessage(jid, { text: String(text || '') })
    } else if (type === 'image') {
      if (!mediaUrl) return res.status(400).json({ ok: false, error: 'missing_mediaUrl' })
      const buf = Buffer.from(await (await fetch(mediaUrl)).arrayBuffer())
      await st.sock!.sendMessage(jid, { image: buf, caption: caption || '' })
    } else if (type === 'audio') {
      if (!mediaUrl) return res.status(400).json({ ok: false, error: 'missing_mediaUrl' })
      const buf = Buffer.from(await (await fetch(mediaUrl)).arrayBuffer())
      await st.sock!.sendMessage(jid, { audio: buf, ptt: !!ptt })
    } else {
      return res.status(400).json({ ok: false, error: 'unsupported_type' })
    }
    res.json({ ok: true })
  } catch (e: any) {
    logger.warn({ e }, 'send failed')
    res.status(500).json({ ok: false, error: 'send_failed', detail: String(e?.message || e) })
  }
})

// Raccourcis
app.post('/sessions/:id/messages/text', async (req, res) => {
  req.body = { ...(req.body || {}), type: 'text' }
  ;(app as any).handle(req, res)
})
app.post('/sessions/:id/messages/image', async (req, res) => {
  req.body = { ...(req.body || {}), type: 'image' }
  ;(app as any).handle(req, res)
})
app.post('/sessions/:id/messages/audio', async (req, res) => {
  req.body = { ...(req.body || {}), type: 'audio' }
  ;(app as any).handle(req, res)
})

// Statut simple
app.get('/sessions/:id/status', async (req, res) => {
  if (!requireAuth(req, res)) return
  const id = req.params.id
  const st = await createOrGetSession(id)
  const phone = (() => {
    try { return jidToPhone(st.sock?.user?.id) } catch { return null }
  })()
  res.json({ ok: true, session_id: id, status: st.status, phone, connected_at: st.connectedAt || null })
})

http.createServer(app).listen(PORT, () => logger.info({ port: PORT }, 'gateway listening'))
