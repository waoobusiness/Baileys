// src/server.ts
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
  type WASocket
} from '@whiskeysockets/baileys'

/* ========= config & helpers ========= */

const log = pino({ level: process.env.LOG_LEVEL || 'info' })
const API_KEY   = process.env.API_KEY   || 'dev-key'
const DATA_DIR  = process.env.DATA_DIR  || '/data'
const AUTH_DIR  = process.env.AUTH_DIR  || path.join(DATA_DIR, 'auth')
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, 'media')

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
  await fs.mkdir(authPath, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(authPath)
  const { version } = await fetchLatestBaileysVersion()

const sock = makeWASocket({
  version,
  auth: state,
  printQRInTerminal: false,
  // fingerprint plus "passe-partout"
  browser: Browsers.ubuntu('Chrome'), // ou Browsers.windows('Chrome')
  // éviter les transferts volumineux pendant l’appairage
  syncFullHistory: false,
  markOnlineOnConnect: false,
  // timeouts un peu plus généreux après l’appairage
  connectTimeoutMs: 60_000,
  defaultQueryTimeoutMs: 60_000
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
    }
    if (connection === 'close') {
      const reason = (lastDisconnect as any)?.error?.message || 'unknown'
      rec.status = 'close'
      rec.phone = null
      log.warn({ sessionId, reason }, 'session closed')
    }
    if (connection === 'connecting') {
      rec.status = 'connecting'
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

/* ========= http server ========= */

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))

// create/ensure session
app.post('/sessions', authz, async (req, res) => {
  try {
    const id = (req.body?.sessionId as string)?.trim()
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

// session status
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

// per-session QR
app.get('/sessions/:id/qr', authz, (req, res) => {
  const id = req.params.id
  const rec = ensureSessionRec(id)
  const entry = rec.lastQR && (Date.now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
  if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: id })
  return res.json({ sessionId: id, qr: entry.qr, qrAt: entry.ts })
})

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

// global QR for 'default' (compat)
app.get('/qr', authz, (_req, res) => {
  const id = 'default'
  const rec = ensureSessionRec(id)
  const entry = rec.lastQR && (Date.now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
  if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: id })
  return res.json({ sessionId: id, qr: entry.qr, qrAt: entry.ts })
})

// pairing-code (if supported by the lib)
app.post('/sessions/:id/pairing-code', authz, async (req, res) => {
  try {
    const id = req.params.id
    const { phoneNumber, custom } = req.body || {}
    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' })

    const rec = await startSocket(id)
    const sock = rec.sock!
    // @ts-ignore – some versions expose requestPairingCode
    if (typeof sock.requestPairingCode !== 'function') {
      return res.status(501).json({ error: 'pairing-code-not-supported' })
    }
    // @ts-ignore
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

async function boot() {
  // create required folders (no top-level await)
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.mkdir(AUTH_DIR, { recursive: true })
  await fs.mkdir(MEDIA_DIR, { recursive: true })

  const PORT = Number(process.env.PORT || 3001)
  app.listen(PORT, () => {
    log.info({ DATA_DIR, AUTH_DIR, MEDIA_DIR }, 'paths ready')
    log.info(`HTTP listening on :${PORT}`)
    // auto-boot default session for compat
    startSocket('default').catch(err => log.warn({ err }, 'default session start failed'))
  })
}

boot().catch(err => {
  log.error({ err }, 'fatal boot error')
  process.exit(1)
})
