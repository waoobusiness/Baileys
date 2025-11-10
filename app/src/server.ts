// src/server.ts
import 'dotenv/config'
import express, { Request, Response } from 'express'
import cors from 'cors'
import pino from 'pino'
import { Boom } from '@hapi/boom'
import {
  WASocket,
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  WAMessageKey,
  jidDecode
} from '@whiskeysockets/baileys'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'

// ============ CONFIG ============
const PORT = Number(process.env.PORT || 10000)
const AUTH_TOKEN = (process.env.AUTH_TOKEN || '').trim()
const DATA_DIR = process.env.DATA_DIR || '/data/wa-auth'
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'
const AUTO_DOWNLOAD_MEDIA = (process.env.AUTO_DOWNLOAD_MEDIA || '0') === '1'

const logger = pino({ level: LOG_LEVEL })

// ============ EXPRESS ============
const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// -------- auth middleware (Bearer) --------
function requireAuth(req: Request, res: Response, next: Function) {
  if (!AUTH_TOKEN) return res.status(500).json({ error: 'AUTH_TOKEN not set' })
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (token !== AUTH_TOKEN) return res.status(403).json({ error: 'forbidden' })
  next()
}

// ============ STATE ============
let sock: WASocket | undefined
const store = makeInMemoryStore({ logger })

// SSE state (QR + status)
let lastQR: string | null = null
let lastStatus: string = 'closed'
const sseClients = new Set<Response>()
function sseBroadcast(payload: any) {
  const data = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try { res.write(data) } catch {}
  }
}

// Helpers
function jidNormalize(input: string) {
  if (!input) return input
  if (input.includes('@')) return input
  return `${String(input).replace(/\D/g, '')}@s.whatsapp.net`
}

function messageToText(m: any): { type: string; text?: string } {
  if (!m?.message) return { type: 'unknown' }
  const msg = m.message
  if (msg.conversation) return { type: 'conversation', text: msg.conversation }
  if (msg.extendedTextMessage?.text) return { type: 'extendedText', text: msg.extendedTextMessage.text }
  if (msg.imageMessage?.caption) return { type: 'image', text: msg.imageMessage.caption }
  if (msg.videoMessage?.caption) return { type: 'video', text: msg.videoMessage.caption }
  if (msg.documentMessage?.title) return { type: 'document', text: msg.documentMessage.title }
  if (msg.audioMessage) return { type: 'audio' }
  if (msg.stickerMessage) return { type: 'sticker' }
  return { type: Object.keys(msg)[0] || 'unknown' }
}

function fromCodePointsHex(hex: string) {
  const parts = hex.trim().split(/\s+/).map(h => parseInt(h, 16))
  return String.fromCodePoint(...parts)
}
function normalizeEmoji(e?: string, hex?: string) {
  if (hex && hex.trim()) return fromCodePointsHex(hex)
  if (!e || !e.trim()) return '👍'
  if (e === '❤') return '❤️'
  if (e === '✔') return '✔️'
  return e
}

// ============ START / RESET SOCKET ============

async function bindSockEvents(sock: WASocket, saveCreds: () => Promise<void>) {
  store.bind(sock.ev)

  // QR & connection updates
  sock.ev.on('connection.update', async (u: any) => {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      lastQR = qr
      sseBroadcast({ type: 'qr', qr })
      logger.info('QR ready')
    }

    if (connection) {
      lastStatus = connection
      sseBroadcast({ type: 'status', status: connection })
      logger.info({ msg: `connection: ${connection}` })
    }

    if (connection === 'close') {
      const err = (lastDisconnect?.error || {}) as Boom<any>
      // @ts-ignore
      const code = (err as any)?.output?.statusCode || (err as any)?.statusCode || (err as any)?.code
      const reason = (err as any)?.message || ''
      const loggedOut =
        code === DisconnectReason.loggedOut ||
        code === 401 ||
        reason.includes('logged out') ||
        reason.includes('device_removed')

      logger.warn({ code, reason }, 'connection close')

      // Reset auth + restart so that /qr repropose un nouveau QR
      await resetAuthAndRestart()
    }
    if (connection === 'open') {
      lastQR = null
      sseBroadcast({ type: 'ready' })
      logger.info('WhatsApp connection OPEN')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // messages
  sock.ev.on('messages.upsert', async (ev: any) => {
    if (ev.type !== 'notify') return
    if (!AUTO_DOWNLOAD_MEDIA) return
    // (on garde simple; pas de download automatique ici pour éviter les 403 flood)
  })
}

async function startSock() {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(DATA_DIR)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Zuria.AI', 'Chrome', '1.0.0'],
    logger
  })

  logger.info({ version }, 'Using WhatsApp version')
  bindSockEvents(sock, saveCreds)
}

async function resetAuthAndRestart() {
  try { await sock?.logout().catch(() => {}) } catch {}
  try { await fsp.rm(DATA_DIR, { recursive: true, force: true }) } catch {}
  sock = undefined
  lastQR = null
  lastStatus = 'closed'
  sseBroadcast({ type: 'status', status: 'closed' })
  await startSock()
}

// boot
startSock().catch(async (e) => {
  logger.error({ e }, 'boot failed, resetting auth and retry')
  await resetAuthAndRestart()
})

// ============ ROUTES: HTML helper ============

app.get('/', (_req, res) => {
  res.send(`<html><head><meta charset="utf-8"><title>Zuria.AI WA</title></head>
  <body style="font-family:system-ui;padding:24px">
    <h1>Zuria.AI — WhatsApp Gateway</h1>
    <p><a href="/qr">Scanner /qr</a> • <a href="/events" target="_blank">Events</a> • <a href="/health">health</a></p>
    <pre>Status: ${lastStatus}</pre>
  </body></html>`)
})

app.get('/qr', (_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>QR</title>
<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js"></script>
<style>body{font-family:system-ui;padding:24px}#q{width:360px;height:360px}</style>
</head><body>
  <h1>Scanne avec WhatsApp</h1>
  <canvas id="q"></canvas>
  <p id="s">Status: ${lastStatus}</p>
<script>
  const c = document.getElementById('q')
  const s = document.getElementById('s')
  const draw = (txt) => {
    if (!txt) return
    QRCode.toCanvas(c, txt, { width: 360 }, (err)=>{ if(err) console.error(err) })
  }
  if (${JSON.stringify(lastQR)}){
    draw(${JSON.stringify(lastQR)})
    s.textContent = 'Status: pending'
  } else {
    s.textContent = 'QR pas encore prêt — recharge dans 3 s'
    setTimeout(()=>location.reload(), 3000)
  }
  const evt = new EventSource('/events')
  evt.onmessage = (e) => {
    try{
      const payload = JSON.parse(e.data)
      if(payload.type==='qr'){ draw(payload.qr); s.textContent='Status: pending' }
      if(payload.type==='status'){ s.textContent='Status: '+payload.status }
      if(payload.type==='ready'){ s.textContent='Déjà lié ✅'; }
    }catch(_){}
  }
</script>
</body></html>`)
})

// SSE stream
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  sseClients.add(res)
  // send initial status
  res.write(`data: ${JSON.stringify({ type: 'status', status: lastStatus })}\n\n`)
  if (lastQR) res.write(`data: ${JSON.stringify({ type: 'qr', qr: lastQR })}\n\n`)
  req.on('close', () => sseClients.delete(res))
})

// ============ ROUTES: HEALTH / SESSION ============
app.get('/health', (_req, res) => res.json({ ok: true }))
app.get('/healt', (_req, res) => res.json({ ok: true })) // (orthographe tolérée)

app.post('/session/reset', requireAuth, async (_req, res) => {
  await resetAuthAndRestart()
  res.json({ ok: true, status: 'reset', next: '/qr' })
})

// ============ ROUTES: INFO ============
app.get('/me', (_req, res) => {
  const me = sock?.user || null
  res.json({ me })
})

app.get('/profile-pic', requireAuth, async (req, res) => {
  try {
    const jid = jidNormalize(String(req.query.jid || ''))
    if (!jid) return res.status(400).json({ error: 'jid required' })
    const url = await sock!.profilePictureUrl(jid as any).catch(() => null)
    res.json({ jid, url })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ============ ROUTES: LISTING ============
app.get('/contacts', requireAuth, async (_req, res) => {
  const arr = Object.values(store.contacts)
    .map((c: any) => ({
      jid: c.id,
      name: c.name || c.verifiedName || '',
      notify: c.notify || '',
      verifiedName: c.verifiedName || '',
      isBusiness: !!c.biz
    }))
  res.json({ count: arr.length, contacts: arr })
})

app.get('/chats', requireAuth, async (_req, res) => {
  const chats = store.chats.all()
  const mapped = chats.map((c: any) => ({
    jid: c.id,
    name: c.name || '',
    unreadCount: c.unreadCount || 0,
    lastMsgTs: c.conversationTimestamp || undefined
  }))
  res.json({ count: mapped.length, chats: mapped })
})

app.get('/messages', requireAuth, async (req, res) => {
  try {
    const jid = jidNormalize(String(req.query.jid || ''))
    const limit = Number(req.query.limit || 25)
    if (!jid) return res.status(400).json({ error: 'jid required' })
    const msgs = await store.loadMessages(jid, limit)
    const mapped = msgs.map((m: any) => {
      const t = messageToText(m)
      return {
        key: m.key,
        pushName: m.pushName,
        timestamp: Number(m.messageTimestamp || m.message?.messageContextInfo?.deviceListMetadata?.timestamp || Date.now()),
        type: t.type,
        text: t.text,
        reactions: m.message?.reactionMessage ? [m.message.reactionMessage.text] : [],
        raw: undefined
      }
    })
    res.json({ jid, count: mapped.length, messages: mapped })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ============ ROUTES: SEND ============
app.post('/send-text', requireAuth, async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'Socket not ready' })
    const { to, text } = req.body || {}
    if (!to || !text) return res.status(400).json({ error: 'to and text required' })
    const jid = jidNormalize(to)
    await sock.sendMessage(jid, { text: String(text) })
    res.json({ ok: true, to: jid })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/send-image', requireAuth, async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'Socket not ready' })
    const { to, url, dataUrl, caption } = req.body || {}
    if (!to || (!url && !dataUrl)) return res.status(400).json({ error: 'to and (url or dataUrl) required' })
    const jid = jidNormalize(to)
    if (url) {
      await sock.sendMessage(jid, { image: { url }, caption })
    } else {
      const base64 = String(dataUrl).split(',')[1] || dataUrl
      const bin = Buffer.from(base64, 'base64')
      await sock.sendMessage(jid, { image: bin, caption })
    }
    res.json({ ok: true, to: jid })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ---------- Send audio (voice note or regular) ----------
app.post('/send-audio', requireAuth, async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'Socket not ready' })
    const { to, url, dataUrl, ptt } = req.body || {}
    if (!to || (!url && !dataUrl)) return res.status(400).json({ error: 'to and (url or dataUrl) required' })
    const jid = jidNormalize(to)
    if (url) {
      await sock.sendMessage(jid, { audio: { url }, ptt: !!ptt })
    } else {
      const base64 = String(dataUrl).split(',')[1] || dataUrl
      const bin = Buffer.from(base64, 'base64')
      await sock.sendMessage(jid, { audio: bin, ptt: !!ptt })
    }
    res.json({ ok: true, to: jid, ptt: !!ptt })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ---------- Send document (PDF, DOCX, etc.) ----------
app.post('/send-document', requireAuth, async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'Socket not ready' })
    const { to, url, dataUrl, mimetype, fileName } = req.body || {}
    if (!to || (!url && !dataUrl)) return res.status(400).json({ error: 'to and (url or dataUrl) required' })
    const jid = jidNormalize(to)
    const mt = mimetype || 'application/pdf'
    const name = fileName || 'document.pdf'
    if (url) {
      await sock.sendMessage(jid, { document: { url }, mimetype: mt, fileName: name })
    } else {
      const base64 = String(dataUrl).split(',')[1] || dataUrl
      const bin = Buffer.from(base64, 'base64')
      await sock.sendMessage(jid, { document: bin, mimetype: mt, fileName: name })
    }
    res.json({ ok: true, to: jid, mimetype: mt, fileName: name })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ---------- React to a message ----------
app.post('/react', requireAuth, async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'Socket not ready' })
    const { jid, id, emoji, emojiCode } = req.body || {}
    if (!jid || !id) return res.status(400).json({ error: 'jid and id required' })
    const j = jidNormalize(jid)
    // find original message
    const msgs = await store.loadMessages(j, 50)
    const original = msgs.find((m: any) => m.key?.id === id)
    if (!original) return res.status(404).json({ error: 'message not found in store' })
    const emj = normalizeEmoji(emoji, emojiCode)
    await sock.sendMessage(j, { react: { text: emj, key: original.key as WAMessageKey } })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ============ START SERVER ============
app.listen(PORT, () => {
  logger.info(`HTTP server listening on :${PORT}`)
})
