import express from 'express'
import cors from 'cors'
import pino from 'pino'
import path from 'node:path'
import fs from 'node:fs'
import QRCode from 'qrcode'
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  type WASocket
} from '@whiskeysockets/baileys'
import { HttpsProxyAgent } from 'https-proxy-agent'

/* ========= config ========= */

const log = pino({ level: process.env.LOG_LEVEL || 'info' })

const API_KEY   = process.env.API_KEY  || 'dev-key'
const DATA_DIR  = process.env.DATA_DIR || '/data'
const AUTH_DIR  = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth_info_baileys')
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, 'media')

// évite top-level await : crée les dossiers en sync
for (const p of [DATA_DIR, AUTH_DIR, MEDIA_DIR]) {
  try { fs.mkdirSync(p, { recursive: true }) } catch {}
}

type SessionRec = {
  id: string
  sock?: WASocket
  status: 'connecting' | 'open' | 'close'
  phone?: string | null
  lastQR?: { qr: string; ts: number } | null
  savingCreds?: boolean
}

const sessions = new Map<string, SessionRec>()
const QR_TTL_MS = 90_000

/* ========= helpers ========= */

const authz = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const key = req.get('x-api-key') || (req.query.key as string)
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' })
  next()
}

const ensureSessionRec = (id: string): SessionRec => {
  let rec = sessions.get(id)
  if (!rec) {
    rec = { id, status: 'close', phone: null, lastQR: null }
    sessions.set(id, rec)
  }
  return rec
}

/* ========= socket lifecycle ========= */

async function startSocket(sessionId: string): Promise<SessionRec> {
  const rec = ensureSessionRec(sessionId)
  if (rec.sock) return rec

  const authPath = path.join(AUTH_DIR, sessionId)
  try { fs.mkdirSync(authPath, { recursive: true }) } catch {}

  const { state, saveCreds } = await useMultiFileAuthState(authPath)
  const { version } = await fetchLatestBaileysVersion()

  // ⚠️ Proxy pour la websocket WhatsApp: utiliser WS_PROXY_URL (pas HTTPS_PROXY)
  const proxyUrl = process.env.WS_PROXY_URL
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,           // activera après login si besoin
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    agent
  })

  rec.sock = sock
  rec.status = 'connecting'
  rec.phone = null
  rec.lastQR = null

  sock.ev.on('creds.update', async () => {
    if (rec.savingCreds) return
    rec.savingCreds = true
    try { await saveCreds() } finally { rec.savingCreds = false }
  })

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) rec.lastQR = { qr, ts: Date.now() }

    if (connection === 'open') {
      rec.status = 'open'
      rec.phone = sock.user?.id || null
      log.info({ sessionId, phone: rec.phone }, 'session connected')
    } else if (connection === 'close') {
      const err = (lastDisconnect as any)?.error
      let reason =
        err?.output?.payload?.message ||
        err?.message ||
        (err?.data && JSON.stringify(err.data)) ||
        'unknown'
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
  if (rec.sock) {
    try { await rec.sock.logout() } catch {}
    try { rec.sock.ws.close() } catch {}
  }
  sessions.delete(sessionId)
}

/* ========= http server ========= */

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))

// créer / assurer une session
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
      counts: { chats: 0, contacts: 0 },
      qrAvailable: !!(rec.lastQR && Date.now() - rec.lastQR.ts < QR_TTL_MS)
    })
  } catch (e: any) {
    log.error({ err: e }, 'start session failed')
    return res.status(500).json({ error: e?.message || 'start-failed' })
  }
})

// statut
app.get('/sessions/:id', authz, (req, res) => {
  const id = req.params.id
  const rec = ensureSessionRec(id)
  return res.json({
    ok: true,
    sessionId: id,
    status: rec.status === 'open' ? 'connected' : rec.status,
    isConnected: rec.status === 'open',
    me: rec.phone ? { id: rec.phone } : undefined,
    phoneNumber: rec.phone || null,
    counts: { chats: 0, contacts: 0 },
    qrAvailable: !!(rec.lastQR && Date.now() - rec.lastQR.ts < QR_TTL_MS)
  })
})

// QR (JSON)
app.get('/sessions/:id/qr', authz, (req, res) => {
  const id = req.params.id
  const rec = ensureSessionRec(id)
  const entry = rec.lastQR && (Date.now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
  if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: id })
  return res.json({ sessionId: id, qr: entry.qr, qrAt: entry.ts })
})

// QR (PNG)
app.get('/sessions/:id/qr.png', authz, async (req, res) => {
  const id = req.params.id
  const rec = ensureSessionRec(id)
  const entry = rec.lastQR && (Date.now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
  if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: id })
  try {
    const png = await QRCode.toBuffer(entry.qr, { errorCorrectionLevel: 'M', margin: 1, width: 512 })
    res.setHeader('Content-Type', 'image/png')
    return res.send(png)
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'qr-png-failed' })
  }
})

// compat: QR global pour "default"
app.get('/qr', authz, (_req, res) => {
  const id = 'default'
  const rec = ensureSessionRec(id)
  const entry = rec.lastQR && (Date.now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
  if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: id })
  return res.json({ sessionId: id, qr: entry.qr, qrAt: entry.ts })
})

// pairing-code (si la lib l’expose)
app.post('/sessions/:id/pairing-code', authz, async (req, res) => {
  try {
    const id = req.params.id
    const { phoneNumber, custom } = req.body || {}
    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' })

    const rec = await startSocket(id)
    const sock = rec.sock as any
    if (typeof sock.requestPairingCode !== 'function') {
      return res.status(501).json({ error: 'pairing-code-not-supported' })
    }
    const code: string = await sock.requestPairingCode(String(phoneNumber), custom ? String(custom) : undefined)
    return res.json({ sessionId: id, pairingCode: code })
  } catch (e: any) {
    log.error({ err: e }, 'pairing failed')
    return res.status(500).json({ error: e?.message || 'pairing-failed' })
  }
})

// logout
app.post('/sessions/:id/logout', authz, async (req, res) => {
  const id = req.params.id
  await logoutSession(id)
  return res.json({ ok: true, sessionId: id, status: 'disconnected' })
})

// reset total
app.delete('/sessions/:id', authz, async (req, res) => {
  const id = req.params.id
  await logoutSession(id)
  try { fs.rmSync(path.join(AUTH_DIR, id), { recursive: true, force: true }) } catch {}
  return res.json({ ok: true, sessionId: id, status: 'deleted' })
})

const PORT = Number(process.env.PORT || 3001)
app.listen(PORT, () => {
  log.info({ DATA_DIR, AUTH_DIR, MEDIA_DIR }, 'paths ready')
  log.info(`HTTP listening on :${PORT}`)
  startSocket('default').catch(err => log.warn({ err }, 'default session start failed'))
})
