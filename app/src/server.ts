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
const API_KEY = process.env.API_KEY || 'dev-key'
const DATA_DIR = process.env.DATA_DIR || '/data'
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth')
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, 'media')

await fs.mkdir(DATA_DIR, { recursive: true })
await fs.mkdir(AUTH_DIR, { recursive: true })
await fs.mkdir(MEDIA_DIR, { recursive: true })

type SessionStatus = 'connecting' | 'open' | 'close'

type SessionRec = {
  id: string
  sock?: WASocket
  status: SessionStatus
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

async function bootstrapSocket(sessionId: string): Promise<WASocket> {
  const authPath = path.join(AUTH_DIR, sessionId)
  await fs.mkdir(authPath, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(authPath)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // on gère le QR nous-mêmes
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: true,
    markOnlineOnConnect: false
  })

  // important: sauvegarder les creds pour éviter les expirations
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds()
    } catch (e) {
      log.warn({ sessionId, err: e }, 'saveCreds failed')
    }
  })

  return sock
}

/**
 * (Re)démarre le socket si nécessaire.
 * - Si pas de socket ou status === 'close' => (re)création.
 * - Si 'connecting' ou 'open' => renvoie tel quel.
 */
async function startSocket(sessionId: string): Promise<SessionRec> {
  const rec = ensureSessionRec(sessionId)

  // Si on a déjà un socket et qu’il n’est pas 'close', on réutilise.
  if (rec.sock && rec.status !== 'close') return rec

  // Sinon on recrée proprement
  if (rec.sock) {
    try { await rec.sock.end(undefined) } catch {}
    rec.sock = undefined
  }

  const sock = await bootstrapSocket(sessionId)
  rec.sock = sock
  rec.status = 'connecting'
  rec.phone = null
  rec.lastQR = null

  // stocke un mini état debug des updates
  debugState.set(sessionId, { at: Date.now(), update: { note: 'boot' }, status: rec.status })

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u

    // garde pour debug
    debugState.set(sessionId, {
      at: Date.now(),
      update: u,
      status: rec.status,
      phone: rec.phone
    })

    if (qr) {
      rec.lastQR = { qr, ts: Date.now() }
    }

    if (connection === 'open') {
      rec.status = 'open'
      rec.phone = sock.user?.id || null
      log.info({ sessionId, phone: rec.phone }, 'session connected')
    } else if (connection === 'close') {
      const reason =
        (lastDisconnect as any)?.error?.message ||
        (lastDisconnect as any)?.error?.toString?.() ||
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
    try { await rec.sock.end(undefined) } catch {}
  }
  sessions.delete(sessionId)
  // On laisse les fichiers d’auth si on veut re-login sans QR; pour repartir from scratch supprimer AUTH_DIR/sessionId côté ops.
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

// explicit restart (force un nouveau socket)
app.post('/sessions/:id/restart', authz, async (req, res) => {
  const id = req.params.id
  try {
    const rec0 = ensureSessionRec(id)
    if (rec0.sock) {
      try { await rec0.sock.end(undefined) } catch {}
      rec0.sock = undefined
      rec0.status = 'close'
    }
    const rec = await startSocket(id)
    return res.json({
      ok: true,
      sessionId: id,
      status: rec.status === 'open' ? 'connected' : rec.status,
      isConnected: rec.status === 'open'
    })
  } catch (e: any) {
    log.error({ err: e, sessionId: id }, 'restart failed')
    return res.status(500).json({ error: e?.message || 'restart-failed' })
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

// per-session QR (raw)
app.get('/sessions/:id/qr', authz, (req, res) => {
  const id = req.params.id
  const rec = ensureSessionRec(id)
  const entry = rec.lastQR && (Date.now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
  if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: id })
  return res.json({ sessionId: id, qr: entry.qr, qrAt: entry.ts })
})

// per-session QR (PNG, prêt à afficher)
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

// global QR for 'default' (compat, déconseillé)
app.get('/qr', authz, (_req, res) => {
  const id = 'default'
  const rec = ensureSessionRec(id)
  const entry = rec.lastQR && (Date.now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
  if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: id })
  return res.json({ sessionId: id, qr: entry.qr, qrAt: entry.ts })
})

// pairing-code (si dispo dans la lib)
app.post('/sessions/:id/pairing-code', authz, async (req, res) => {
  try {
    const id = req.params.id
    const { phoneNumber, custom } = req.body || {}
    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' })
    const rec = await startSocket(id)
    const sock = rec.sock!
    // @ts-ignore – certaines versions exposent requestPairingCode
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

/* ===== debug helpers ===== */

const debugState = new Map<string, any>()

app.get('/sessions/:id/debug', authz, (req, res) => {
  const id = req.params.id
  return res.json(debugState.get(id) || { note: 'no-events-yet' })
})

/* ========= boot ========= */

const PORT = Number(process.env.PORT || 3001)
app.listen(PORT, () => {
  log.info({ DATA_DIR, AUTH_DIR, MEDIA_DIR }, 'paths ready')
  log.info(`HTTP listening on :${PORT}`)
  // boot par défaut (compat) — tu peux enlever si tu veux tout gérer par /sessions
  startSocket('default').catch(err => log.warn({ err }, 'default session start failed'))
})
