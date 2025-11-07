import express from 'express'
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import pino from 'pino'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  WASocket,
  WAMessage,
} from '@whiskeysockets/baileys'

/** ================== Config de base ================== */
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })
const PORT = Number(process.env.PORT || 3001)
const API_KEY = process.env.API_KEY || process.env.X_API_KEY || 'MY_PRIVATE_FURIA_API_KEY_2025'

const DATA_DIR = process.env.DATA_DIR || '/data'
const AUTH_BASE = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth_info_baileys')
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, 'media')

/** Webhook global (fallback si pas de webhook par session) */
const GLOBAL_WEBHOOK_URL = process.env.WEBHOOK_URL_GLOBAL || ''
const GLOBAL_WEBHOOK_SECRET = process.env.WEBHOOK_SECRET_GLOBAL || ''

/** ================== Types & mémoire ================== */
type SessionConfig = {
  webhookUrl?: string
  webhookSecret?: string
  assistantId?: string
  headers?: Record<string, string>
}

type SessionRuntime = {
  sock: WASocket | null
  lastQR?: string
  me?: { id?: string; name?: string | null }
  phoneNumber?: string | null
  counts?: { chats?: number; contacts?: number }
  config: SessionConfig
}

const sessions = new Map<string, SessionRuntime>()

/** ================== Utils FS ================== */
const ensureDirs = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.mkdir(AUTH_BASE, { recursive: true })
  await fs.mkdir(MEDIA_DIR, { recursive: true })
  logger.info({ DATA_DIR, AUTH_BASE, MEDIA_DIR }, 'paths ready')
}

const sessionDir = (id: string) => path.join(DATA_DIR, 'sessions', id)
const configPath = (id: string) => path.join(sessionDir(id), 'config.json')

async function loadConfig(id: string): Promise<SessionConfig> {
  try {
    const buf = await fs.readFile(configPath(id), 'utf-8')
    return JSON.parse(buf) as SessionConfig
  } catch {
    return {}
  }
}

async function saveConfig(id: string, cfg: SessionConfig) {
  const dir = sessionDir(id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(configPath(id), JSON.stringify(cfg, null, 2), 'utf-8')
}

/** ================== Auth middleware ================== */
function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.header('x-api-key')
  const qKey = req.query.key as string | undefined
  if (header === API_KEY || qKey === API_KEY) return next()
  return res.status(401).json({ error: 'unauthorized' })
}

/** ================== HMAC signature ================== */
function signBody(body: any, secret: string): string {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

async function postWebhook(sessionId: string, type: string, data: any) {
  const s = sessions.get(sessionId)
  const cfg = s?.config || {}
  const url = cfg.webhookUrl || GLOBAL_WEBHOOK_URL
  const secret = cfg.webhookSecret || GLOBAL_WEBHOOK_SECRET
  if (!url || !secret) return

  const payload = {
    event: type,
    sessionId,
    assistantId: cfg.assistantId,
    phoneNumber: s?.phoneNumber,
    me: s?.me,
    timestamp: Date.now(),
    ...data,
  }

  const sig = signBody(payload, secret)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-webhook-signature': sig,
  }
  if (cfg.headers) {
    for (const [k, v] of Object.entries(cfg.headers)) headers[k] = String(v)
  }

  try {
    await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })
  } catch (e) {
    logger.warn({ err: (e as any)?.message, sessionId, url }, 'webhook post failed')
  }
}

/** ================== Helpers ================== */
function jidToPhone(jid?: string | null) {
  if (!jid) return null
  // ex: "4176xxxxxxx@s.whatsapp.net"
  return jid.split('@')[0]?.split(':')[0] || null
}

function extractText(m: WAMessage): string | undefined {
  const msg = m.message
  if (!msg) return
  // plusieurs variations possibles selon WA
  if ((msg as any).conversation) return (msg as any).conversation
  if ((msg as any).extendedTextMessage?.text) return (msg as any).extendedTextMessage.text
  if ((msg as any).imageMessage?.caption) return (msg as any).imageMessage.caption
  if ((msg as any).videoMessage?.caption) return (msg as any).videoMessage.caption
  return
}

/** ================== Démarrage socket ================== */
async function startSocket(sessionId: string) {
  const authPath = path.join(AUTH_BASE, sessionId)
  await fs.mkdir(authPath, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(authPath)

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    printQRInTerminal: false, // QR géré via events
    logger,
  })

  // init runtime if absent
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sock,
      config: await loadConfig(sessionId),
      counts: {},
    })
  } else {
    const s = sessions.get(sessionId)!
    s.sock = sock
  }

  await postWebhook(sessionId, 'session:created', {})

  // Events
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u) => {
    const s = sessions.get(sessionId)
    if (!s) return
    if (u.qr) {
      s.lastQR = u.qr
      await postWebhook(sessionId, 'qr:update', { qr: 'AVAILABLE' })
    }
    if (u.connection === 'open') {
      const me = sock.user || {}
      s.me = { id: me.id, name: (me as any).name || null }
      s.phoneNumber = jidToPhone(me.id)
      await postWebhook(sessionId, 'session:connected', {})
    }
    if (u.connection === 'close') {
      const code = (u.lastDisconnect as any)?.error?.output?.statusCode
      await postWebhook(sessionId, 'session:disconnected', { reason: code })
      const shouldReconnect = code !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        setTimeout(() => startSocket(sessionId).catch(() => {}), 1500)
      }
    }
  })

  sock.ev.on('messages.upsert', async (ev) => {
    for (const m of ev.messages) {
      const isFromMe = !!m.key.fromMe
      const from = m.key.remoteJid
      const text = extractText(m)
      const payload = isFromMe
        ? { event: 'message:outbound', messageId: m.key.id, to: from, text }
        : { event: 'message:inbound', from, to: sock.user?.id, text, type: text ? 'text' : 'other' }
      await postWebhook(sessionId, payload.event, payload)
    }
  })

  return sock
}

/** Assure qu’une session existe (et la (re)démarre si besoin) */
async function ensureSession(sessionId: string) {
  if (sessions.get(sessionId)?.sock) return sessions.get(sessionId)!
  const cfg = await loadConfig(sessionId)
  sessions.set(sessionId, { sock: null, config: cfg })
  const sock = await startSocket(sessionId)
  const s = sessions.get(sessionId)!
  s.sock = sock
  return s
}

/** ================== HTTP API ================== */
const app = express()
app.use(express.json())

// Santé
app.get('/', (_, res) => res.send('ok'))
app.get('/health', (_, res) => res.json({ ok: true }))

// Auth protégé
app.use(auth)

/** Créer/assurer session */
app.post('/sessions', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || 'default')
    await ensureSession(sessionId)
    const s = sessions.get(sessionId)!
    res.json({ ok: true, sessionId, status: s.sock?.user ? 'connected' : 'connecting', isConnected: !!s.sock?.user })
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'session create failed')
    res.status(500).json({ error: 'session create failed' })
  }
})

/** Statut session */
app.get('/sessions/:id', async (req, res) => {
  try {
    const id = req.params.id
    await ensureSession(id)
    const s = sessions.get(id)!
    res.json({
      ok: true,
      sessionId: id,
      status: s.sock?.user ? 'connected' : 'connecting',
      isConnected: !!s.sock?.user,
      me: s.me,
      phoneNumber: s.phoneNumber,
      counts: s.counts || {},
      qrAvailable: !!s.lastQR,
    })
  } catch {
    res.status(500).json({ error: 'status failed' })
  }
})

/** Supprimer session */
app.delete('/sessions/:id', async (req, res) => {
  const id = req.params.id
  try {
    const s = sessions.get(id)
    if (s?.sock) {
      try { await s.sock.logout() } catch {}
    }
    sessions.delete(id)
    // on peut choisir de purger les creds:
    // await fs.rm(path.join(AUTH_BASE, id), { recursive: true, force: true })
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'delete failed' })
  }
})

/** QR (facile à intégrer côté Lovable) */
app.get('/qr', async (req, res) => {
  const sessionId = String(req.query.sessionId || 'default')
  try {
    await ensureSession(sessionId)
    const s = sessions.get(sessionId)!
    if (!s.lastQR) return res.status(404).json({ error: 'no-qr-available' })
    res.json({ sessionId, qr: s.lastQR })
  } catch {
    res.status(500).json({ error: 'qr failed' })
  }
})

/** Pairing code */
app.post('/sessions/:id/pairing-code', async (req, res) => {
  try {
    const id = req.params.id
    const { phoneNumber, custom } = req.body || {}
    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required (E.164 without +)' })
    const s = await ensureSession(id)
    if (!s.sock) throw new Error('socket not ready')
    // pairing ne marche que si pas encore enregistré
    if ((s.sock.authState?.creds as any)?.registered) {
      return res.status(400).json({ error: 'already registered; delete session and retry' })
    }
    const code = await s.sock.requestPairingCode(String(phoneNumber), custom ? String(custom) : undefined)
    res.json({ sessionId: id, pairingCode: code })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'pairing failed' })
  }
})

/** Contacts minimal */
app.get('/sessions/:id/contacts', async (req, res) => {
  try {
    const id = req.params.id
    const s = await ensureSession(id)
    if (!s.sock) return res.status(503).json({ error: 'socket-not-ready' })
    const all = Object.entries((s.sock as any).store?.contacts || {}).map(([jid, c]: any) => ({
      jid,
      name: c?.name || c?.notify || null,
      verifiedName: c?.verifiedName || null,
      isBusiness: !!c?.isBusiness,
      isEnterprise: !!c?.isEnterprise,
    }))
    s.counts = { ...(s.counts || {}), contacts: all.length }
    res.json({ sessionId: id, count: all.length, contacts: all })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'contacts failed' })
  }
})

/** Photo de contact (si dispo en store) */
app.get('/sessions/:id/contacts/:jid/photo', async (req, res) => {
  try {
    const id = req.params.id
    const s = await ensureSession(id)
    if (!s.sock) return res.status(503).json({ error: 'socket-not-ready' })
    const jid = req.params.jid
    const url = await s.sock.profilePictureUrl(jid).catch(() => null)
    if (!url) return res.status(404).json({ error: 'no-photo' })
    res.json({ url })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'photo failed' })
  }
})

/** Chats (liste simple) */
app.get('/sessions/:id/chats', async (req, res) => {
  try {
    const id = req.params.id
    const s = await ensureSession(id)
    if (!s.sock) return res.status(503).json({ error: 'socket-not-ready' })
    const store = (s.sock as any).store
    const chatsArr = store?.chats ? Array.from(store.chats.values()) : []
    const simplified = chatsArr.map((c: any) => ({
      id: c.id,
      name: c.name || c.formattedName || null,
      unreadCount: c.unreadCount || 0,
      archived: !!c.archived,
    }))
    s.counts = { ...(s.counts || {}), chats: simplified.length }
    res.json({ sessionId: id, count: simplified.length, chats: simplified })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'chats failed' })
  }
})

/** Envoi texte */
app.post('/sessions/:id/messages/send', async (req, res) => {
  try {
    const id = req.params.id
    const s = await ensureSession(id)
    if (!s.sock) return res.status(503).json({ error: 'socket-not-ready' })
    const to = String(req.body?.to || '').trim()
    const text = String(req.body?.text || '').trim()
    if (!to || !text) return res.status(400).json({ error: 'to & text required' })
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
    const r = await s.sock.sendMessage(jid, { text })
    await postWebhook(id, 'message:outbound', { messageId: r?.key?.id, to })
    res.json({ ok: true, messageId: r?.key?.id })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'send failed' })
  }
})

/** ======== NOUVEAU : Webhook par session ======== */
app.post('/sessions/:id/webhook', async (req, res) => {
  try {
    const id = req.params.id
    const { webhookUrl, secret, assistantId, headers } = req.body || {}
    if (!webhookUrl || !secret) return res.status(400).json({ error: 'webhookUrl & secret required' })
    await ensureSession(id)
    const current = sessions.get(id)!
    current.config = { webhookUrl, webhookSecret: secret, assistantId, headers }
    await saveConfig(id, current.config)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'webhook set failed' })
  }
})

app.get('/sessions/:id/webhook', async (req, res) => {
  try {
    const id = req.params.id
    const cfg = await loadConfig(id)
    res.json({ ok: true, hasWebhook: !!cfg.webhookUrl && !!cfg.webhookSecret, assistantId: cfg.assistantId, webhookUrl: cfg.webhookUrl || null })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'webhook get failed' })
  }
})

/** ================================================== */

async function main() {
  await ensureDirs()
  app.listen(PORT, () => logger.info(`HTTP listening on :${PORT}`))
  // Optionnel : démarrer une session par défaut si voulu
  // await ensureSession('default').catch(err => logger.warn({ err }, 'default session start failed'))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
