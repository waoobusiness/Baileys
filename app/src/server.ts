import express from 'express'
import pino from 'pino'
import path from 'node:path'
import fs from 'node:fs/promises'
import makeWASocket, {
  useMultiFileAuthState,
  Browsers
} from '@vkazee/baileys'

const PORT = Number(process.env.PORT || 3001)
const API_KEY = process.env.API_KEY || process.env.GATEWAY_API_KEY || ''
const DATA_DIR = process.env.DATA_DIR || '/data'
const AUTH_ROOT = path.join(DATA_DIR, 'auth')
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, 'media')

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

type SessionState = {
  id: string
  sock: any
  lastQr?: string
  lastQrAt?: number
  connected?: boolean
  me?: { id?: string; name?: string }
  counts: { chats: number; contacts: number }
  knownJids: Set<string>          // alimenté à la volée (messages, updates)
}

const sessions = new Map<string, SessionState>()

/** auth simple middleware (sauf /health) */
function auth(req: any, res: any, next: any) {
  if (req.path === '/health') return next()
  const key = req.header('x-api-key') || req.query.key
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  return next()
}

/** crée le dossier s'il n'existe pas */
async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

/** Start (or return) a WA socket for sessionId */
async function startSocket(sessionId: string) {
  // reuse if already started
  const current = sessions.get(sessionId)
  if (current?.sock) {
    return current
  }

  const authDir = path.join(AUTH_ROOT, sessionId)
  await ensureDir(authDir)
  await ensureDir(MEDIA_DIR)

  const { state, saveCreds } = await useMultiFileAuthState(authDir)

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: true,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 90_000
  })

  // init
  const s: SessionState = {
    id: sessionId,
    sock,
    lastQr: undefined,
    lastQrAt: undefined,
    connected: false,
    me: undefined,
    counts: { chats: 0, contacts: 0 },
    knownJids: new Set<string>()
  }
  sessions.set(sessionId, s)

  // creds persistence
  ;(sock.ev as any).on('creds.update', saveCreds)

  // connection lifecycle + QR tracking
  ;(sock.ev as any).on('connection.update', (u: any) => {
    const { connection, lastDisconnect, qr } = u || {}
    if (qr) {
      s.lastQr = qr
      s.lastQrAt = Date.now()
      logger.info({ sessionId, qrAt: s.lastQrAt }, 'QR updated')
    }
    if (connection === 'open') {
      s.connected = true
      s.me = { id: sock?.user?.id, name: sock?.user?.name }
      logger.info({ sessionId, me: s.me }, 'connection open')
    }
    if (connection === 'close') {
      s.connected = false
      const code = (lastDisconnect as any)?.error?.output?.statusCode
      logger.warn({ sessionId, code }, 'connection closed')
      // ici on NE relance PAS automatiquement: session pilotée par API
    }
  })

  // messages: on mémorise juste les jids rencontrés
  ;(sock.ev as any).on('messages.upsert', (ev: any) => {
    try {
      for (const m of ev?.messages || []) {
        const jid = m?.key?.remoteJid
        if (jid) s.knownJids.add(jid)
      }
    } catch {}
  })

  // contacts/chats counters best-effort (pas de types stricts)
  ;(sock.ev as any).on('chats.upsert', (ev: any) => {
    try { s.counts.chats = Math.max(s.counts.chats, (ev?.length || 0)) } catch {}
  })
  ;(sock.ev as any).on('contacts.upsert', (ev: any) => {
    try { s.counts.contacts = Math.max(s.counts.contacts, (ev?.length || 0)) } catch {}
  })

  return s
}

/** status payload */
function sessionStatusPayload(s: SessionState) {
  return {
    ok: true,
    sessionId: s.id,
    status: s.connected ? 'connected' : 'connecting',
    isConnected: !!s.connected,
    me: s.me,
    phoneNumber: s.me?.id || null,
    counts: s.counts,
    qrAvailable: !!s.lastQr
  }
}

/** Express app */
const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(auth)

app.get('/health', (_req, res) => res.json({ ok: true }))

/**
 * POST /sessions
 * body: { sessionId: string }
 * -> crée/démarre la session (sans auto-start d'une "default")
 */
app.post('/sessions', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || '').trim()
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' })

    const s = await startSocket(sessionId)
    return res.json(sessionStatusPayload(s))
  } catch (e: any) {
    logger.error({ err: e }, 'start session failed')
    return res.status(500).json({ error: e?.message || 'start failed' })
  }
})

/**
 * GET /sessions/:id
 * -> statut courant
 */
app.get('/sessions/:id', async (req, res) => {
  try {
    const sessionId = req.params.id
    let s = sessions.get(sessionId)
    if (!s) {
      // ne pas autostart silencieusement; renvoie connecting si auth existe,
      // ou demande de POST /sessions d’abord
      const authDir = path.join(AUTH_ROOT, sessionId)
      try {
        await fs.access(authDir)
        // auth existe déjà: on peut démarrer
        s = await startSocket(sessionId)
      } catch {
        return res.json({ ok: true, sessionId, status: 'connecting', isConnected: false, counts: { chats: 0, contacts: 0 }, qrAvailable: false })
      }
    }
    return res.json(sessionStatusPayload(s))
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'status failed' })
  }
})

/**
 * GET /sessions/:id/qr
 * -> dernier QR émis pour cette session (rafraîchir côté UI toutes les ~2s tant que connecting)
 */
app.get('/sessions/:id/qr', async (req, res) => {
  try {
    const sessionId = req.params.id
    const s = sessions.get(sessionId)
    if (!s) return res.status(404).json({ error: 'session not found' })
    if (!s.lastQr) return res.status(404).json({ error: 'no-qr-available' })
    return res.json({ sessionId, qr: s.lastQr, qrAt: s.lastQrAt })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'qr failed' })
  }
})

/**
 * POST /sessions/:id/pairing-code
 * body: { phoneNumber: "4176...", custom?: "AB12C3DE" }
 * -> génère un code d’appairage (Android “Associer par numéro” uniquement)
 */
app.post('/sessions/:id/pairing-code', async (req, res) => {
  try {
    const sessionId = req.params.id
    const phone = String(req.body?.phoneNumber || '').replace(/\D/g, '')
    const custom = req.body?.custom ? String(req.body.custom).trim() : undefined
    if (!phone) return res.status(400).json({ error: 'phoneNumber required (digits only, with country code)' })

    const s = await startSocket(sessionId)
    if (s.connected || s.sock?.user?.id) {
      return res.status(409).json({ error: 'already connected' })
    }
    const code = await s.sock.requestPairingCode(phone, custom)
    return res.json({ sessionId, pairingCode: code })
  } catch (e: any) {
    logger.error({ err: e }, 'pairing-code failed')
    return res.status(500).json({ error: e?.message || 'pairing-code failed' })
  }
})

/**
 * POST /sessions/:id/logout
 */
app.post('/sessions/:id/logout', async (req, res) => {
  try {
    const sessionId = req.params.id
    const s = sessions.get(sessionId)
    if (!s) return res.json({ ok: true, sessionId, message: 'not running' })
    try { await s.sock?.logout?.() } catch {}
    s.connected = false
    s.lastQr = undefined
    s.lastQrAt = undefined
    return res.json({ ok: true, sessionId, message: 'logged out' })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'logout failed' })
  }
})

/**
 * POST /sessions/:id/messages/send
 * body: { to: "4176...", text?, imageUrl?, videoUrl?, audioUrl?, mimetype? }
 */
app.post('/sessions/:id/messages/send', async (req, res) => {
  try {
    const sessionId = req.params.id
    const s = sessions.get(sessionId)
    if (!s?.sock) return res.status(503).json({ error: 'session not running' })

    const to = String(req.body?.to || '').replace(/\D/g, '')
    if (!to) return res.status(400).json({ error: 'to (digits) required' })

    const jid = `${to}@s.whatsapp.net`
    const { text, imageUrl, videoUrl, audioUrl, mimetype } = req.body || {}

    let content: any = {}
    if (text) content.text = String(text)

    if (imageUrl) {
      content.image = { url: String(imageUrl) }
      if (text) content.caption = String(text)
    }
    if (videoUrl) {
      content.video = { url: String(videoUrl) }
      if (text) content.caption = String(text)
    }
    if (audioUrl) {
      content.audio = { url: String(audioUrl) }
      if (mimetype) content.mimetype = String(mimetype)
    }

    if (!Object.keys(content).length) {
      return res.status(400).json({ error: 'no message content' })
    }

    const resp = await s.sock.sendMessage(jid, content)
    return res.json({ ok: true, sessionId, to: jid, response: resp })
  } catch (e: any) {
    logger.error({ err: e }, 'send failed')
    return res.status(500).json({ error: e?.message || 'send failed' })
  }
})

/**
 * GET /sessions/:id/photo?jid=<jid>
 * -> URL de photo de profil (si dispo)
 */
app.get('/sessions/:id/photo', async (req, res) => {
  try {
    const sessionId = req.params.id
    const jid = String(req.query.jid || '')
    const s = sessions.get(sessionId)
    if (!s?.sock) return res.status(503).json({ error: 'session not running' })
    if (!jid) return res.status(400).json({ error: 'jid required' })
    const url = await s.sock.profilePictureUrl(jid, 'image').catch(() => null)
    return res.json({ ok: true, sessionId, jid, url })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'photo failed' })
  }
})

/**
 * (optionnel, pour compatibilité tests) GET /qr
 * -> renvoie le premier QR disponible trouvé parmi les sessions actives
 */
app.get('/qr', async (_req, res) => {
  for (const s of sessions.values()) {
    if (s.lastQr) return res.json({ sessionId: s.id, qr: s.lastQr, qrAt: s.lastQrAt })
  }
  return res.status(404).json({ error: 'no-qr-available' })
})

/** bootstrap */
await ensureDir(AUTH_ROOT)
await ensureDir(MEDIA_DIR)
logger.info({ DATA_DIR, AUTH_DIR: AUTH_ROOT, MEDIA_DIR }, 'paths ready')

app.listen(PORT, () => logger.info(`HTTP listening on :${PORT}`))
