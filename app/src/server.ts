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
  makeInMemoryStore,
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
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
const ok = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.mkdir(AUTH_DIR, { recursive: true })
  await fs.mkdir(MEDIA_DIR, { recursive: true })
}
const authz: express.RequestHandler = (req, res, next) => {
  const key = req.get('x-api-key') || (req.query.key as string)
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' })
  next()
}
const now = () => Date.now()

/* ========= sessions ========= */
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
  store: ReturnType<typeof makeInMemoryStore>
  mediaIndex: Map<string, MediaMeta>
  webhook?: string | null
  savingCreds?: boolean
}

const sessions = new Map<string, SessionRec>()

const ensureSessionRec = (id: string): SessionRec => {
  let rec = sessions.get(id)
  if (!rec) {
    rec = {
      id,
      status: 'close',
      phone: null,
      lastQR: null,
      store: makeInMemoryStore({}),
      mediaIndex: new Map(),
      webhook: null,
    }
    sessions.set(id, rec)
  }
  return rec
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

  // bind store
  rec.store.bind(sock.ev)

  sock.ev.on('creds.update', async () => {
    if (rec.savingCreds) return
    rec.savingCreds = true
    try { await saveCreds() } finally { rec.savingCreds = false }
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

  // incoming messages -> index media + webhook
  sock.ev.on('messages.upsert', async (evt) => {
    for (const m of evt.messages) {
      try {
        indexMedia(rec, m)
        await pushWebhook(rec, m)
      } catch (e:any) {
        log.warn({ err:e, sessionId, id:m.key.id }, 'messages.upsert handler failed')
      }
    }
  })

  return rec
}

async function logoutSession(sessionId: string) {
  const rec = ensureSessionRec(sessionId)
  if (rec.sock) {
    try { await rec.sock.logout() } catch {}
  }
  sessions.delete(sessionId)
}

/* ========= media helpers ========= */
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

  const pick = (): MediaMeta | null => {
    if (content.imageMessage) {
      return {
        id, jid, type: 'image',
        mimetype: content.imageMessage.mimetype,
        bytes: Number(content.imageMessage.fileLength || 0),
        ts: Number(m.messageTimestamp) || now()
      }
    }
    if (content.videoMessage) {
      return {
        id, jid, type: 'video',
        mimetype: content.videoMessage.mimetype,
        bytes: Number(content.videoMessage.fileLength || 0),
        seconds: Number(content.videoMessage.seconds || 0),
        ts: Number(m.messageTimestamp) || now()
      }
    }
    if (content.audioMessage) {
      return {
        id, jid, type: 'audio',
        mimetype: content.audioMessage.mimetype,
        bytes: Number(content.audioMessage.fileLength || 0),
        seconds: Number(content.audioMessage.seconds || 0),
        ts: Number(m.messageTimestamp) || now()
      }
    }
    if (content.documentMessage) {
      return {
        id, jid, type: 'document',
        mimetype: content.documentMessage.mimetype,
        fileName: content.documentMessage.fileName || undefined,
        bytes: Number(content.documentMessage.fileLength || 0),
        ts: Number(m.messageTimestamp) || now()
      }
    }
    if (content.stickerMessage) {
      return {
        id, jid, type: 'sticker',
        mimetype: content.stickerMessage.mimetype,
        bytes: Number(content.stickerMessage.fileLength || 0),
        ts: Number(m.messageTimestamp) || now()
      }
    }
    return null
  }

  const meta = pick()
  if (meta) rec.mediaIndex.set(id, meta)
}

async function makeDownloadUrl(sessionId: string, messageId: string) {
  // URL que l’UI peut appeler sans header (clé en query)
  return `${PUBLIC_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(messageId)}.bin?key=${encodeURIComponent(API_KEY)}`
}

async function pushWebhook(rec: SessionRec, m: WAMessage) {
  if (!rec.webhook) return
  const id = m.key.id
  const jid = m.key.remoteJid
  if (!id || !jid) return

  const content = unwrapMsgContent(m)
  const text = content.conversation
          || content.extendedTextMessage?.text
          || null

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

  // fire-and-forget
  fetch(rec.webhook, {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {})
}

/* ========= http server ========= */
const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))

/* -- sessions -- */
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
      counts: {
        chats: rec.store.chats.all().length,
        contacts: Object.keys(rec.store.contacts).length
      },
      qrAvailable: !!(rec.lastQR && now() - rec.lastQR.ts < QR_TTL_MS)
    })
  } catch (e:any) {
    log.error({ err:e }, 'start session failed')
    return res.status(500).json({ error: e?.message || 'start-failed' })
  }
})

app.get('/sessions/:id', authz, (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  return res.json({
    ok: true,
    sessionId: rec.id,
    status: rec.status === 'open' ? 'connected' : rec.status,
    isConnected: rec.status === 'open',
    me: rec.phone ? { id: rec.phone } : undefined,
    phoneNumber: rec.phone || null,
    counts: {
      chats: rec.store.chats.all().length,
      contacts: Object.keys(rec.store.contacts).length
    },
    qrAvailable: !!(rec.lastQR && now() - rec.lastQR.ts < QR_TTL_MS)
  })
})

app.post('/sessions/:id/logout', authz, async (req, res) => {
  await logoutSession(req.params.id)
  return res.json({ ok: true, sessionId: req.params.id, status: 'disconnected' })
})

/* -- QR & pairing -- */
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
app.get('/qr', authz, (req, res) => {
  const rec = ensureSessionRec('default')
  const entry = rec.lastQR && (now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
  if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: rec.id })
  return res.json({ sessionId: rec.id, qr: entry.qr, qrAt: entry.ts })
})

app.post('/sessions/:id/pairing-code', authz, async (req, res) => {
  try {
    const id = req.params.id
    const phone = String(req.body?.phoneNumber || '').trim()
    const custom = req.body?.custom ? String(req.body.custom) : undefined
    if (!phone) return res.status(400).json({ error: 'phoneNumber required' })

    const rec = await startSocket(id)
    const sock = rec.sock!
    // @ts-ignore - certaines versions exposent requestPairingCode
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

/* -- webhook par session -- */
app.post('/sessions/:id/webhook', authz, (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const url = String(req.body?.url || '').trim()
  if (!url) return res.status(400).json({ error: 'url required' })
  rec.webhook = url
  return res.json({ ok:true, sessionId: rec.id, webhook: url })
})

/* -- contacts, chats, pp, groups -- */
app.get('/sessions/:id/contacts', authz, (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  res.json({ ok:true, contacts: Object.values(rec.store.contacts || {}) })
})
app.get('/sessions/:id/chats', authz, (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  res.json({ ok:true, chats: rec.store.chats.all() })
})
app.get('/sessions/:id/groups', authz, async (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  try {
    const groups = await rec.sock!.groupFetchAllParticipating()
    res.json({ ok:true, groups })
  } catch(e:any) {
    res.status(500).json({ error: e?.message || 'groups-failed' })
  }
})
app.get('/sessions/:id/profile-picture', authz, async (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const jid = String(req.query.jid || '')
  if (!jid) return res.status(400).json({ error: 'jid required' })
  try {
    const pp = await rec.sock!.profilePictureUrl(jid, 'image') // HD si dispo
    res.json({ ok:true, jid, url: pp })
  } catch (e:any) {
    res.status(500).json({ error: e?.message || 'pp-failed' })
  }
})

/* -- messages: récents (store) & historique (WA) -- */
app.get('/sessions/:id/messages/recent', authz, async (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const jid = String(req.query.jid || '')
  const count = Math.max(1, Math.min(100, Number(req.query.count || 25)))
  if (!jid) return res.status(400).json({ error: 'jid required' })
  try {
    const msgs = await rec.store.loadMessages(jid, count)
    res.json({ ok:true, jid, messages: msgs })
  } catch (e:any) {
    res.status(500).json({ error: e?.message || 'load-recent-failed' })
  }
})

app.get('/sessions/:id/messages/history', authz, async (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const jid = String(req.query.jid || '')
  const count = Math.max(1, Math.min(50, Number(req.query.count || 25)))
  if (!jid) return res.status(400).json({ error: 'jid required' })
  try {
    const current = await rec.store.loadMessages(jid, 1, undefined)
    const oldest = current?.[0]
    if (!oldest) return res.status(404).json({ error: 'no-anchor' })
    // @ts-ignore – API exposée par Baileys (voir docs Vkazee)
    await rec.sock!.fetchMessageHistory(count, oldest.key, oldest.messageTimestamp)
    res.json({ ok:true, requested: count })
  } catch (e:any) {
    res.status(500).json({ error: e?.message || 'history-fetch-failed' })
  }
})

/* -- media download (tous types) -- */
app.get('/sessions/:id/media/:messageId.bin', authz, async (req, res) => {
  const rec = ensureSessionRec(req.params.id)
  const mid = req.params.messageId
  const allChats = rec.store.chats.all().map(c => c.id)

  // retrouve le message par id en balayant les chats en mémoire
  let found: WAMessage | undefined
  for (const jid of allChats) {
    const msgs = await rec.store.loadMessages(jid, 50)
    const hit = msgs.find(x => x.key.id === mid)
    if (hit) { found = hit; break }
  }
  if (!found) return res.status(404).json({ error: 'message-not-found' })

  try {
    const buf = await downloadMediaMessage(
      // @ts-ignore – accepte WAMessage ou IMessage
      found,
      'buffer',
      { startByte: 0 },
      { reuploadRequest: rec.sock!.updateMediaMessage, logger: log as any }
    ) // API documentée dans le code source Baileys. 

    const content = unwrapMsgContent(found)
    const mime =
      content.imageMessage?.mimetype ||
      content.videoMessage?.mimetype ||
      content.audioMessage?.mimetype ||
      content.documentMessage?.mimetype ||
      content.stickerMessage?.mimetype ||
      'application/octet-stream'

    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'private, max-age=60')
    res.send(buf)
  } catch (e:any) {
    res.status(500).json({ error: e?.message || 'media-download-failed' })
  }
})

/* -- send text/media (facultatif) -- */
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

/* -- boot -- */
async function boot() {
  await ok()
  const PORT = Number(process.env.PORT || 3001)
  app.listen(PORT, () => {
    log.info({ DATA_DIR, AUTH_DIR, MEDIA_DIR }, 'paths ready')
    log.info(`HTTP listening on :${PORT}`)
    startSocket('default').catch(err => log.warn({ err }, 'default session start failed'))
  })
}
boot()
