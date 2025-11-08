import express from 'express'
import cors from 'cors'
import pino from 'pino'
import path from 'node:path'
import fs from 'node:fs/promises'
import QRCode from 'qrcode'
import { HttpsProxyAgent } from 'https-proxy-agent'
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  type WASocket,
  DisconnectReason
} from '@whiskeysockets/baileys'

/* ========= config ========= */

const log = pino({ level: process.env.LOG_LEVEL || 'info' })
const API_KEY = process.env.API_KEY || 'dev-key'

const DATA_DIR = process.env.DATA_DIR || '/data'
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth_info_baileys')
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, 'media')

const WS_PROXY_URL = process.env.WS_PROXY_URL || ''

/* ========= types & state ========= */

type SessionRec = {
  id: string
  sock?: WASocket
  status: 'connecting' | 'open' | 'close'
  phone?: string | null
  lastQR?: { qr: string; ts: number } | null
  savingCreds?: boolean
  restarting?: boolean
}

const sessions = new Map<string, SessionRec>()
const QR_TTL_MS = 90_000

/* ========= helpers ========= */

const authz: express.RequestHandler = (req, res, next) => {
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

/** Abonne un handler et le désabonne via le retour cleanup */
function subscribeConnectionUpdate(sock: WASocket, cb: (u: any) => void) {
  const handler = (u: any) => cb(u)
  // @ts-ignore types de l'EventEmitter Baileys
  sock.ev.on('connection.update', handler)
  return () => {
    // @ts-ignore
    sock.ev.off('connection.update', handler)
  }
}

function onceWithTimeout<T>(
  subscribe: (cb: (v: T) => void) => () => void,
  pred: (v: T) => boolean,
  ms = 20000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const cleanup = subscribe((v) => {
      if (done) return
      if (pred(v)) {
        done = true
        clearTimeout(t)
        cleanup()
        resolve(v)
      }
    })
    const t = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      reject(new Error('timeout'))
    }, ms)
  })
}

/* ========= socket lifecycle ========= */

async function startSocket(sessionId: string): Promise<SessionRec> {
  const rec = ensureSessionRec(sessionId)
  if (rec.sock) return rec

  const authPath = path.join(AUTH_DIR, sessionId)
  await fs.mkdir(authPath, { recursive: true })
  await fs.mkdir(MEDIA_DIR, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(authPath)
  const { version } = await fetchLatestBaileysVersion()

  const agent = WS_PROXY_URL ? new HttpsProxyAgent(WS_PROXY_URL) : undefined

  // NB: on caste en any pour accepter connectOptions malgré le typage actuel
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
    ...(agent ? { connectOptions: { agent } } : {})
  } as any)

  rec.sock = sock
  rec.status = 'connecting'
  rec.phone = null
  rec.lastQR = null

  // Debounce simple pour saveCreds
  let saving = false
  sock.ev.on('creds.update', async () => {
    if (saving) return
    saving = true
    try {
      await saveCreds()
    } catch (err) {
      log.warn({ err, sessionId }, 'saveCreds failed')
    } finally {
      saving = false
    }
  })

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      rec.lastQR = { qr, ts: Date.now() }
    }
    if (connection === 'open') {
      rec.status = 'open'
      rec.phone = sock.user?.id || null
      log.info({ sessionId, phone: rec.phone }, 'session connected')
    } else if (connection === 'close') {
      const boom: any = lastDisconnect?.error
      const code = boom?.output?.statusCode
      const reason = boom?.message || 'unknown'

      rec.status = 'close'
      rec.phone = null
      log.warn({ sessionId, code, reason }, 'session closed')

      if (code === DisconnectReason.restartRequired && !rec.restarting) {
        rec.restarting = true
        setTimeout(async () => {
          try { try { await rec.sock?.logout() } catch {} } finally {
            rec.sock = undefined
            rec.restarting = false
            await startSocket(sessionId)
          }
        }, 1500)
      }
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
  }
  sessions.delete(sessionId)
}

/* ========= HTTP server ========= */

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.mkdir(AUTH_DIR, { recursive: true })
  await fs.mkdir(MEDIA_DIR, { recursive: true })

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

  // per-session QR (JSON)
  app.get('/sessions/:id/qr', authz, (req, res) => {
    const id = req.params.id
    const rec = ensureSessionRec(id)
    const entry = rec.lastQR && (Date.now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
    if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: id })
    return res.json({ sessionId: id, qr: entry.qr, qrAt: entry.ts })
  })

  // per-session QR (PNG)
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

  // global QR (compat) pour "default"
  app.get('/qr', authz, (_req, res) => {
    const id = 'default'
    const rec = ensureSessionRec(id)
    const entry = rec.lastQR && (Date.now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
    if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: id })
    return res.json({ sessionId: id, qr: entry.qr, qrAt: entry.ts })
  })

  // pairing code — attendre la fenêtre "connecting/qr"
  app.post('/sessions/:id/pairing-code', authz, async (req, res) => {
    try {
      const id = req.params.id
      const { phoneNumber, custom } = req.body || {}
      if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' })

      const rec = await startSocket(id)
      const sock = rec.sock!

      // @ts-ignore
      if (sock.authState?.creds?.registered) {
        return res.status(400).json({ error: 'already-registered' })
      }

      await onceWithTimeout(
        (cb) => subscribeConnectionUpdate(sock, cb as any),
        // ok dès qu'on voit "connecting" ou un qr
        (u: any) => u?.connection === 'connecting' || !!u?.qr,
        20000
      )

      // @ts-ignore
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

  const PORT = Number(process.env.PORT || 3001)
  app.listen(PORT, () => {
    log.info({ DATA_DIR, AUTH_DIR, MEDIA_DIR }, 'paths ready')
    log.info(`HTTP listening on :${PORT}`)
    startSocket('default').catch(err => log.warn({ err }, 'default session start failed'))
  })
}

main().catch((err) => {
  log.error({ err }, 'fatal startup error')
  process.exit(1)
})
