import express from 'express'
import cors from 'cors'
import pino from 'pino'
import path from 'node:path'
import fs from 'node:fs/promises'
import QRCode from 'qrcode'
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
  type WASocket,
  type WAMessage
} from '@whiskeysockets/baileys'

/* ========= config ========= */

const log = pino({ level: process.env.LOG_LEVEL || 'info' })
const API_KEY = process.env.API_KEY || 'dev-key'
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:3001'
const DATA_DIR = process.env.DATA_DIR || '/data'
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth_info_baileys')
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, 'media')

const QR_TTL_MS = 90_000

/* ========= helpers ========= */

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.mkdir(AUTH_DIR, { recursive: true })
  await fs.mkdir(MEDIA_DIR, { recursive: true })
}
const now = () => Date.now()

const authz: express.RequestHandler = (req, res, next) => {
  const key = req.get('x-api-key') || (req.query.key as string)
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' })
  next()
}

/* ========= simple in-memory store ========= */

type Contact = Record<string, any>
type Chat = Record<string, any>

type MediaMeta = {
  id: string
  jid: string
  type: 'image'|'video'|'audio'|'document'|'sticker'
  mimetype?: string
  fileName?: string
  seconds?: number
  bytes?: number
  ts: number
}

type SessionRec = {
  id: string
  sock?: WASocket
  status: 'connecting'|'open'|'close'
  phone?: string|null
  lastQR?: { qr: string; ts: number } | null
  savingCreds?: boolean

  contacts: Map<string, Contact>
  chats: Map<string, Chat>
  messages: Map<string, WAMessage[]>
  mediaIndex: Map<string, MediaMeta>
  webhook?: string | null
}

const sessions = new Map<string, SessionRec>()

function ensureSessionRec(id: string): SessionRec {
  let rec = sessions.get(id)
  if (!rec) {
    rec = {
      id,
      status: 'close',
      phone: null,
      lastQR: null,
      contacts: new Map(),
      chats: new Map(),
      messages: new Map(),
      mediaIndex: new Map(),
      webhook: null
    }
    sessions.set(id, rec)
  }
  return rec
}

function unwrapMsgContent(m: WAMessage) {
  const msg = m.message || {}
  if ((msg as any).viewOnceMessage?.message) return (msg as any).viewOnceMessage.message
  return msg
}

function indexMedia(rec: SessionRec, m: WAMessage) {
  const content = unwrapMsgContent(m)
  const id = m.key.id
  const jid = m.key.remoteJid
  if (!id || !jid) return

  const meta =
    content.imageMessage ? ({
      id, jid, type: 'image',
      mimetype: content.imageMessage.mimetype,
      bytes: Number(content.imageMessage.fileLength || 0),
      ts: Number(m.messageTimestamp) || now()
    } as MediaMeta)
  : content.videoMessage ? ({
      id, jid, type: 'video',
      mimetype: content.videoMessage.mimetype,
      bytes: Number(content.videoMessage.fileLength || 0),
      seconds: Number(content.videoMessage.seconds || 0),
      ts: Number(m.messageTimestamp) || now()
    } as MediaMeta)
  : content.audioMessage ? ({
      id, jid, type: 'audio',
      mimetype: content.audioMessage.mimetype,
      bytes: Number(content.audioMessage.fileLength || 0),
      seconds: Number(content.audioMessage.seconds || 0),
      ts: Number(m.messageTimestamp) || now()
    } as MediaMeta)
  : content.documentMessage ? ({
      id, jid, type: 'document',
      mimetype: content.documentMessage.mimetype,
      fileName: content.documentMessage.fileName || undefined,
      bytes: Number(content.documentMessage.fileLength || 0),
      ts: Number(m.messageTimestamp) || now()
    } as MediaMeta)
  : content.stickerMessage ? ({
      id, jid, type: 'sticker',
      mimetype: content.stickerMessage.mimetype,
      bytes: Number(content.stickerMessage.fileLength || 0),
      ts: Number(m.messageTimestamp) || now()
    } as MediaMeta)
  : null

  if (meta) rec.mediaIndex.set(id, meta)
}

async function makeDownloadUrl(sessionId: string, messageId: string) {
  return `${PUBLIC_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(messageId)}.bin?key=${encodeURIComponent(API_KEY)}`
}

async function pushWebhook(rec: SessionRec, m: WAMessage) {
  if (!rec.webhook) return
  const id = m.key.id, jid = m.key.remoteJid
  if (!id || !jid) return

  const c = unwrapMsgContent(m)
  const text = c.conversation || c.extendedTextMessage?.text || null
  const media = rec.mediaIndex.get(id)
  const mediaUrl = media ? await makeDownloadUrl(rec.id, id) : null

  const payload = {
    type: 'message',
    sessionId: rec.id,
    messageId: id,
    chatId: jid,
    fromMe: !!m.key.fromMe,
    timestamp: Number(m.messageTimestamp) || now(),
    text,
    media: media ? {
      kind: media.type,
      mimetype: media.mimetype || null,
      seconds: media.seconds || null,
      bytes: media.bytes || null,
      fileName: media.fileName || null,
      url: mediaUrl
    } : null
  }

  fetch(rec.webhook, {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {})
}

/* ========= socket lifecycle ========= */

async function startSocket(sessionId: string): Promise<SessionRec> {
  const rec = ensureSessionRec(sessionId)
  if (rec.sock) return rec

  const authPath = path.join(AUTH_DIR, sessionId)
  await fs.mkdir(authPath, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(authPath)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: true
  })

  rec.sock = sock
  rec.status = 'connecting'
  rec.lastQR = null
  rec.phone = null

  // creds
  sock.ev.on('creds.update', async () => {
    if (rec.savingCreds) return
    rec.savingCreds = true
    try { await saveCreds() } finally { rec.savingCreds = false }
  })

  // contacts/chats — cast en any pour contourner le mismatch de typings
  ;(sock.ev as any).on('contacts.set', ({ contacts }: any) => {
    rec.contacts.clear()
    for (const [id, v] of Object.entries(contacts)) rec.contacts.set(id, v as Contact)
  })
  ;(sock.ev as any).on('contacts.upsert', (arr: any[]) => {
    for (const c of arr) {
      const prev = rec.contacts.get(c.id) || {}
      rec.contacts.set(c.id, { ...prev, ...c })
    }
  })
  ;(sock.ev as any).on('chats.set', ({ chats }: any) => {
    rec.chats.clear()
    for (const c of chats) rec.chats.set(c.id, c as Chat)
  })
  sock.ev.on('chats.upsert', (arr: any[]) => {
    for (const c of arr) rec.chats.set(c.id, c as Chat)
  })
  sock.ev.on('chats.update', (arr: any[]) => {
    for (const upd of arr) {
      const prev = rec.chats.get(upd.id) || {}
      rec.chats.set(upd.id, { ...prev, ...upd })
    }
  })

  // message stream
  sock.ev.on('messages.upsert', async (evt) => {
    for (const m of evt.messages) {
      try {
        const jid = m.key.remoteJid!
        const list = rec.messages.get(jid) || []
        list.push(m)
        if (list.length > 500) list.splice(0, list.length - 500)
        rec.messages.set(jid, list)

        indexMedia(rec, m)
        await pushWebhook(rec, m)
      } catch (e:any) {
        log.warn({ err:e, sessionId, id:m.key.id }, 'messages.upsert handler failed')
      }
    }
  })

  // connection + QR
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) rec.lastQR = { qr, ts: now() }

    if (connection === 'open') {
      rec.status = 'open'
      rec.phone = sock.user?.id || null
      log.info({ sessionId, phone: rec.phone }, 'session connected')
    } else if (connection === 'close') {
      const reason = (lastDisconnect as any)?.error?.message || 'unknown'
      rec.status = 'close'
      rec.phone = null
      log.warn({ sessionId, reason }, 'session closed')
    } else if (connection === 'connecting') {
      rec.status = 'connecting'
    }
  })

  return rec
}

async function logoutSession(sessionId: string) {
  const rec = ensureSessionRec(sessionId)
  if (rec.sock) { try { await rec.sock.logout() } catch {} }
  sessions.delete(sessionId)
}

/* ========= http server ========= */

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))

// create/ensure session
app.post('/sessions', authz, async (req, res) => {
  try {
    const id = String(req.body?.sessionId || '').trim()
    if (!id) return res.status(400).json({ error: 'sessionId required' })
    const rec = await startSocket(id)
    return res.json({
      ok: true,
      sessionId: rec.id,
      status: rec.status === 'open' ? 'connected' : rec.status,
      isConnected: rec.status === 'open',
      phoneNumber: rec.phone || null,
      counts: { chats: rec.chats.size, contacts: rec.contacts.size },
      qrAvailable: !!(rec.lastQR && now() - rec.lastQR.ts < QR_TTL_MS)
    })
  } catch (e:any) {
    log.error({ err:e }, 'start session failed')
    return res.status(500).json({ error: e?.message || 'start-failed' })
  }
})

// session status
app.get('/sessions/:id', authz, (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  return res.json({
    ok: true,
    sessionId: rec.id,
    status: rec.status === 'open' ? 'connected' : rec.status,
    isConnected: rec.status === 'open',
    me: rec.phone ? { id: rec.phone } : undefined,
    phoneNumber: rec.phone || null,
    counts: { chats: rec.chats.size, contacts: rec.contacts.size },
    qrAvailable: !!(rec.lastQR && now() - rec.lastQR.ts < QR_TTL_MS)
  })
})

// logout
app.post('/sessions/:id/logout', authz, async (req, res) => {
  await logoutSession(req.params.id)
  return res.json({ ok: true, sessionId: req.params.id, status: 'disconnected' })
})

// per-session QR
app.get('/sessions/:id/qr', authz, (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const entry = rec.lastQR && (now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
  if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: rec.id })
  return res.json({ sessionId: rec.id, qr: entry.qr, qrAt: entry.ts })
})
app.get('/sessions/:id/qr.png', authz, async (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const entry = rec.lastQR && (now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
  if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: rec.id })
  const png = await QRCode.toBuffer(entry.qr, { errorCorrectionLevel: 'M', margin: 1, width: 512 })
  res.setHeader('Content-Type', 'image/png')
  res.send(png)
})
// legacy global QR for default
app.get('/qr', authz, (req, res) => {
  const rec = ensureSessionRec('default')
  const entry = rec.lastQR && (now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
  if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: rec.id })
  return res.json({ sessionId: rec.id, qr: entry.qr, qrAt: entry.ts })
})

// pairing code
app.post('/sessions/:id/pairing-code', authz, async (req, res) => {
  try {
    const id = req.params.id
    const phone = String(req.body?.phoneNumber || '').trim()
    const custom = req.body?.custom ? String(req.body.custom) : undefined
    if (!phone) return res.status(400).json({ error: 'phoneNumber required' })

    const rec = await startSocket(id)
    const sock = rec.sock!
    // @ts-ignore (exposé selon versions)
    if (typeof sock.requestPairingCode !== 'function') {
      return res.status(501).json({ error: 'pairing-code-not-supported' })
    }
    // @ts-ignore
    const code: string = await sock.requestPairingCode(phone, custom)
    return res.json({ sessionId: id, pairingCode: code })
  } catch (e:any) {
    log.error({ err:e }, 'pairing failed')
    return res.status(500).json({ error: e?.message || 'pairing-failed' })
  }
})

// webhook par session
app.post('/sessions/:id/webhook', authz, (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const url = String(req.body?.url || '').trim()
  if (!url) return res.status(400).json({ error: 'url required' })
  rec.webhook = url
  return res.json({ ok:true, sessionId: rec.id, webhook: url })
})

/* ===== contacts / chats / pp ===== */
app.get('/sessions/:id/contacts', authz, (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  res.json({ ok:true, contacts: Array.from(rec.contacts.values()) })
})
app.get('/sessions/:id/chats', authz, (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  res.json({ ok:true, chats: Array.from(rec.chats.values()) })
})
app.get('/sessions/:id/profile-picture', authz, async (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const jid = String(req.query.jid || '')
  if (!jid) return res.status(400).json({ error: 'jid required' })
  try {
    const pp = await rec.sock!.profilePictureUrl(jid, 'image')
    res.json({ ok:true, jid, url: pp })
  } catch (e:any) {
    res.status(500).json({ error: e?.message || 'pp-failed' })
  }
})

/* ===== messages ===== */
app.get('/sessions/:id/messages/recent', authz, async (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const jid = String(req.query.jid || '')
  const count = Math.max(1, Math.min(100, Number(req.query.count || 25)))
  if (!jid) return res.status(400).json({ error: 'jid required' })
  const list = rec.messages.get(jid) || []
  const sorted = [...list].sort((a,b) => Number(a.messageTimestamp||0) - Number(b.messageTimestamp||0))
  res.json({ ok:true, jid, messages: sorted.slice(-count) })
})

// naive history fetch (anchor-based)
app.get('/sessions/:id/messages/history', authz, async (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const jid = String(req.query.jid || '')
  const count = Math.max(1, Math.min(50, Number(req.query.count || 25)))
  if (!jid) return res.status(400).json({ error: 'jid required' })

  const have = rec.messages.get(jid) || []
  const oldest = [...have].sort((a,b) => Number(a.messageTimestamp||0) - Number(b.messageTimestamp||0))[0]
  if (!oldest) return res.status(404).json({ error: 'no-anchor' })
  try {
    // @ts-ignore — selon version
    await rec.sock!.fetchMessageHistory(count, oldest.key, oldest.messageTimestamp)
    res.json({ ok:true, requested: count })
  } catch (e:any) {
    res.status(500).json({ error: e?.message || 'history-fetch-failed' })
  }
})

/* ===== media download (all kinds) ===== */
app.get('/sessions/:id/media/:messageId.bin', authz, async (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const mid = req.params.messageId

  let found: WAMessage | undefined
  for (const [, arr] of rec.messages) {
    const hit = arr.find(x => x.key.id === mid)
    if (hit) { found = hit; break }
  }
  if (!found) return res.status(404).json({ error: 'message-not-found' })

  try {
    const buf = await downloadMediaMessage(
      // @ts-ignore accepts WAMessage/IMessage
      found, 'buffer', { startByte: 0 },
      { reuploadRequest: rec.sock!.updateMediaMessage, logger: log as any }
    )

    const c = unwrapMsgContent(found)
    const mime =
      c.imageMessage?.mimetype ||
      c.videoMessage?.mimetype ||
      c.audioMessage?.mimetype ||
      c.documentMessage?.mimetype ||
      c.stickerMessage?.mimetype ||
      'application/octet-stream'

    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'private, max-age=60')
    res.send(buf)
  } catch (e:any) {
    res.status(500).json({ error: e?.message || 'media-download-failed' })
  }
})

/* ===== send helper ===== */
app.post('/sessions/:id/send', authz, async (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const { jid, text, imageUrl, videoUrl, audioUrl, documentUrl, caption, mimetype } = req.body || {}
  if (!jid) return res.status(400).json({ error: 'jid required' })
  try {
    const msg = imageUrl ? { image: { url: imageUrl }, caption } :
                videoUrl ? { video: { url: videoUrl }, caption } :
                audioUrl ? { audio: { url: audioUrl }, mimetype: mimetype || 'audio/ogg; codecs=opus' } :
                documentUrl ? { document: { url: documentUrl }, mimetype: mimetype || 'application/pdf', caption } :
                { text: text || '' }
    const resp = await rec.sock!.sendMessage(jid, msg)
    res.json({ ok:true, response: resp })
  } catch (e:any) {
    res.status(500).json({ error: e?.message || 'send-failed' })
  }
})

/* ===== boot ===== */
async function boot() {
  await ensureDirs()
  const PORT = Number(process.env.PORT || 3001)
  app.listen(PORT, () => {
    log.info({ DATA_DIR, AUTH_DIR, MEDIA_DIR }, 'paths ready')
    log.info(`HTTP listening on :${PORT}`)
    // démarrage de la session 'default' pour compat /qr
    startSocket('default').catch(err => log.warn({ err }, 'default session start failed'))
  })
}
boot()
