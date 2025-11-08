import express from 'express'
import cors from 'cors'
import pino from 'pino'
import path from 'node:path'
import fs from 'node:fs/promises'
import QRCode from 'qrcode'
import { HttpsProxyAgent } from 'https-proxy-agent'
import crypto from 'node:crypto'
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
const HOOK_DIR = process.env.HOOK_DIR || path.join(DATA_DIR, 'hooks')

const WS_PROXY_URL = process.env.WS_PROXY_URL || ''

/* ========= types & state ========= */

type HookCfg = { url: string; secret: string }

type SessionRec = {
  id: string
  sock?: WASocket
  status: 'connecting' | 'open' | 'close'
  phone?: string | null
  lastQR?: { qr: string; ts: number } | null
  savingCreds?: boolean
  restarting?: boolean
  hook?: HookCfg | null
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
    rec = { id, status: 'close', phone: null, lastQR: null, hook: null }
    sessions.set(id, rec)
  }
  return rec
}

async function readHook(sessionId: string): Promise<HookCfg | null> {
  try {
    const file = path.join(HOOK_DIR, `${sessionId}.json`)
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}
async function writeHook(sessionId: string, cfg: HookCfg | null) {
  const file = path.join(HOOK_DIR, `${sessionId}.json`)
  if (!cfg) {
    try { await fs.unlink(file) } catch {}
    const rec = ensureSessionRec(sessionId)
    rec.hook = null
    return
  }
  await fs.mkdir(HOOK_DIR, { recursive: true })
  await fs.writeFile(file, JSON.stringify(cfg), 'utf8')
  const rec = ensureSessionRec(sessionId)
  rec.hook = cfg
}

function makeProxyAgent(url: string | undefined) {
  if (!url) return undefined
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return new HttpsProxyAgent(u)
    }
    log.warn({ url }, 'WS_PROXY_URL protocol not supported (use http/https); proxy ignored')
    return undefined
  } catch (err) {
    log.warn({ err, url }, 'Invalid WS_PROXY_URL; proxy ignored')
    return undefined
  }
}

function hmacHex(secret: string, body: string) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

async function forwardToWebhook(sessionId: string, type: string, payload: any) {
  const rec = ensureSessionRec(sessionId)
  const hook = rec.hook || (rec.hook = await readHook(sessionId))
  if (!hook) return

  const event = {
    session_id: sessionId,
    phone_number: rec.phone || null,
    event_type: type,
    payload,
    ts: Date.now()
  }
  const body = JSON.stringify(event)
  const sig = hmacHex(hook.secret, body)

  try {
    const rsp = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zuria-session-id': sessionId,
        'x-zuria-signature': sig
      },
      body
    })
    if (!rsp.ok) {
      const txt = await rsp.text().catch(() => '')
      log.warn({ sessionId, status: rsp.status, txt }, 'webhook responded non-200')
    }
  } catch (err) {
    log.warn({ sessionId, err }, 'webhook forward failed')
  }
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
  const agent = makeProxyAgent(WS_PROXY_URL)

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

  // creds
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

  // connection updates
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      rec.lastQR = { qr, ts: Date.now() }
      // On peut forward l'info QR si tu veux monitorer côté backend
      forwardToWebhook(sessionId, 'qr.update', { qrAt: rec.lastQR.ts }).catch(() => {})
    }

    if (connection === 'open') {
      rec.status = 'open'
      rec.phone = sock.user?.id || null
      log.info({ sessionId, phone: rec.phone }, 'session connected')
      forwardToWebhook(sessionId, 'session.connected', { phone: rec.phone }).catch(() => {})
    } else if (connection === 'close') {
      const boom: any = lastDisconnect?.error
      const code = boom?.output?.statusCode
      const reason = boom?.message || 'unknown'

      rec.status = 'close'
      rec.phone = null
      log.warn({ sessionId, code, reason }, 'session closed')
      forwardToWebhook(sessionId, 'session.closed', { code, reason }).catch(() => {})

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

  // messages
  sock.ev.on('messages.upsert', (m) => {
    forwardToWebhook(sessionId, 'messages.upsert', m).catch(() => {})
  })
  sock.ev.on('messages.update', (m) => {
    forwardToWebhook(sessionId, 'messages.update', m).catch(() => {})
  })
  sock.ev.on('messages.reaction', (m) => {
    forwardToWebhook(sessionId, 'messages.reaction', m).catch(() => {})
  })

  // contacts & chats (optionnel mais utile)
  sock.ev.on('contacts.upsert', (c) => {
    forwardToWebhook(sessionId, 'contacts.upsert', c).catch(() => {})
  })
  sock.ev.on('contacts.update', (c) => {
    forwardToWebhook(sessionId, 'contacts.update', c).catch(() => {})
  })
  sock.ev.on('chats.upsert', (c) => {
    forwardToWebhook(sessionId, 'chats.upsert', c).catch(() => {})
  })
  sock.ev.on('chats.update', (c) => {
    forwardToWebhook(sessionId, 'chats.update', c).catch(() => {})
  })

  return rec
}

async function logoutSession(sessionId: string) {
  const rec = ensureSessionRec(sessionId)
  if (rec.sock) {
    try { await rec.sock.logout() } catch {}
  }
  sessions.delete(sessionId)
  try { await writeHook(sessionId, null) } catch {}
}

/* ========= HTTP server ========= */

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.mkdir(AUTH_DIR, { recursive: true })
  await fs.mkdir(MEDIA_DIR, { recursive: true })
  await fs.mkdir(HOOK_DIR, { recursive: true })

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
  // compat pour "default"
  app.get('/qr', authz, (_req, res) => {
    const id = 'default'
    const rec = ensureSessionRec(id)
    const entry = rec.lastQR && (Date.now() - rec.lastQR.ts < QR_TTL_MS) ? rec.lastQR : null
    if (!entry) return res.status(404).json({ error: 'no-qr-available', sessionId: id })
    return res.json({ sessionId: id, qr: entry.qr, qrAt: entry.ts })
  })

  // register per-session webhook
  app.post('/sessions/:id/webhook', authz, async (req, res) => {
    const id = req.params.id
    const { url, secret } = req.body || {}
    if (!url || !secret) return res.status(400).json({ error: 'url & secret required' })
    try {
      // validate URL
      new URL(url)
      await writeHook(id, { url, secret })
      // envoie un test
      await forwardToWebhook(id, 'webhook.test', { ok: true })
      return res.json({ ok: true, sessionId: id })
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'invalid-webhook' })
    }
  })

  app.get('/sessions/:id/webhook', authz, async (req, res) => {
    const id = req.params.id
    const cfg = (ensureSessionRec(id).hook) || await readHook(id)
    return res.json({ ok: true, sessionId: id, hasWebhook: !!cfg })
  })

  app.delete('/sessions/:id/webhook', authz, async (req, res) => {
    const id = req.params.id
    await writeHook(id, null)
    return res.json({ ok: true, sessionId: id })
  })

  // pairing code
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
    log.info({ DATA_DIR, AUTH_DIR, MEDIA_DIR, HOOK_DIR }, 'paths ready')
    log.info(`HTTP listening on :${PORT}`)
    startSocket('default').catch(err => log.warn({ err }, 'default session start failed'))
  })
}

main().catch((err) => {
  log.error({ err }, 'fatal startup error')
  process.exit(1)
})
