import express from 'express'
import cors from 'cors'
import pinoHttp from 'pino-http'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  WASocket
} from '@whiskeysockets/baileys'
import type { Boom } from '@hapi/boom'

const PORT = Number(process.env.PORT || 10000)
const AUTH_ROOT = path.join(process.cwd(), '.baileys_auth')

type SessionStatus = 'qr' | 'connecting' | 'connected' | 'closed'

type Session = {
  id: string
  sock: WASocket
  status: SessionStatus
  startedAt: number
  lastQr?: string
  sse: Set<express.Response>
  webhookUrl?: string
  webhookSecret?: string
}

const sessions = new Map<string, Session>()

// ------------- Utils
function jidFromTo(to: string) {
  const digits = String(to).replace(/\D/g, '')
  return digits.includes('@') ? digits : `${digits}@s.whatsapp.net`
}

async function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true })
  }
}

// ------------- Session lifecycle
async function createSession(id: string, webhookUrl?: string, webhookSecret?: string): Promise<Session> {
  if (sessions.has(id)) return sessions.get(id)!

  await ensureDir(AUTH_ROOT)
  const authDir = path.join(AUTH_ROOT, id)
  await ensureDir(authDir)

  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Zuria.AI'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    emitOwnEvents: true
  })

  const sess: Session = {
    id,
    sock,
    status: 'connecting',
    startedAt: Date.now(),
    sse: new Set(),
    webhookUrl,
    webhookSecret
  }
  sessions.set(id, sess)

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      sess.status = 'qr'
      sess.lastQr = qr
      // push QR to all SSE clients
      for (const res of sess.sse) {
        res.write(`event: qr\ndata: ${JSON.stringify({ qr })}\n\n`)
      }
    }

    if (connection === 'open') {
      sess.status = 'connected'
      for (const res of sess.sse) {
        res.write(`event: connected\ndata: {}\n\n`)
      }
    }

    if (connection === 'close') {
      sess.status = 'closed'
      for (const res of sess.sse) {
        res.write(`event: closed\ndata: {}\n\n`)
      }
      const reason = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      // auto-restart unless explicit logout
      if (reason && reason !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          sessions.delete(id)
          createSession(id, webhookUrl, webhookSecret).catch(() => {})
        }, 1000)
      }
    }
  })

  // Optionnel: brancher le forward vers un webhook si tu veux plus tard
  // sock.ev.on('messages.upsert', async (m) => { ... })

  return sess
}

// ------------- HTTP
const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(pinoHttp())

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

// Démarrer/assurer la session
app.post('/sessions/:id/start', async (req, res) => {
  const { id } = req.params
  const { webhookUrl, webhookSecret } = req.body || {}
  try {
    const s = await createSession(id, webhookUrl, webhookSecret)
    res.json({ ok: true, session_id: id, status: s.status })
  } catch (e: any) {
    req.log?.error(e)
    res.status(500).json({ ok: false, error: 'start_failed', detail: String(e?.message || e) })
  }
})

// Flux SSE pour QR / statut
app.get('/sessions/:id/sse', async (req, res) => {
  const { id } = req.params

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  // @ts-ignore
  res.flushHeaders?.()

  const s = sessions.get(id) || (await createSession(id))
  s.sse.add(res)

  // push état courant
  res.write(`event: status\ndata: ${JSON.stringify({ status: s.status })}\n\n`)
  if (s.status === 'qr' && s.lastQr) {
    res.write(`event: qr\ndata: ${JSON.stringify({ qr: s.lastQr })}\n\n`)
  }

  req.on('close', () => {
    s.sse.delete(res)
  })
})

// Reset total (logout + purge auth + redémarrage)
app.post('/sessions/:id/reset', async (req, res) => {
  const { id } = req.params
  const s = sessions.get(id)
  try {
    if (s) {
      await s.sock.logout()
      sessions.delete(id)
    }
    await fs.rm(path.join(AUTH_ROOT, id), { recursive: true, force: true })
    const ns = await createSession(id)
    res.json({ ok: true, status: ns.status })
  } catch (e: any) {
    req.log?.error(e)
    res.status(500).json({ ok: false, error: 'reset_failed', detail: String(e?.message || e) })
  }
})

// Envoi de messages (texte / image / audio)
app.post('/sessions/:id/messages', async (req, res) => {
  const { id } = req.params
  const { to, type = 'text', text, caption, mediaUrl, ptt = false } = req.body || {}

  const s = sessions.get(id)
  if (!s || s.status !== 'connected' || !s.sock.user) {
    return res.status(409).json({ ok: false, error: 'not_connected' })
  }

  try {
    const jid = jidFromTo(String(to))
    let content: any

    if (type === 'text') {
      content = { text: String(text ?? '') }
    } else if (type === 'image') {
      if (!mediaUrl) throw new Error('mediaUrl required for image')
      content = { image: { url: String(mediaUrl) }, caption: caption ?? '' }
    } else if (type === 'audio') {
      if (!mediaUrl) throw new Error('mediaUrl required for audio')
      content = { audio: { url: String(mediaUrl) }, ptt: Boolean(ptt) }
    } else {
      throw new Error(`unsupported type: ${type}`)
    }

    const resp = await s.sock.sendMessage(jid, content)
    res.json({ ok: true, id: resp.key?.id })
  } catch (e: any) {
    req.log?.error(e)
    res.status(500).json({ ok: false, error: 'send_failed', detail: String(e?.message || e) })
  }
})

app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: 30,
      time: Date.now(),
      app: 'Zuria.AI',
      port: PORT,
      authDir: '.baileys_auth',
      msg: 'Gateway listening'
    })
  )
})
