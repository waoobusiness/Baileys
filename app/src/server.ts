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
  orgId?: string
}

const sessions = new Map<string, Session>()

function jidFromTo(to: string) {
  const digits = String(to).replace(/\D/g, '')
  return digits.includes('@') ? digits : `${digits}@s.whatsapp.net`
}
async function ensureDir(dir: string) {
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true })
}

async function postWebhook(sess: Session, payload: any) {
  if (!sess.webhookUrl) return
  try {
    await fetch(sess.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(sess.webhookSecret ? { 'x-webhook-secret': sess.webhookSecret } : {})
      },
      body: JSON.stringify(payload)
    })
  } catch {}
}

async function createSession(id: string, webhookUrl?: string, webhookSecret?: string, orgId?: string): Promise<Session> {
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
    webhookSecret,
    orgId
  }
  sessions.set(id, sess)

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      sess.status = 'qr'
      sess.lastQr = qr
      // SSE
      for (const res of sess.sse) res.write(`event: qr\ndata: ${JSON.stringify({ qr })}\n\n`)
      // Webhook
      postWebhook(sess, { event: 'session.status', session_id: sess.id, org_id: sess.orgId, status: 'qr' })
    }

    if (connection === 'open') {
      sess.status = 'connected'
      for (const res of sess.sse) res.write(`event: connected\ndata: {}\n\n`)
      postWebhook(sess, { event: 'session.status', session_id: sess.id, org_id: sess.orgId, status: 'connected' })
    }

    if (connection === 'close') {
      sess.status = 'closed'
      for (const res of sess.sse) res.write(`event: closed\ndata: {}\n\n`)
      postWebhook(sess, { event: 'session.status', session_id: sess.id, org_id: sess.orgId, status: 'closed' })
      const reason = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      if (reason && reason !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          sessions.delete(id)
          createSession(id, webhookUrl, webhookSecret, orgId).catch(() => {})
        }, 1000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      const fromMe = !!m.key.fromMe
      const gwJid = m.key.remoteJid || ''
      const normalized = {
        id: m.key.id,
        timestamp: Number(m.messageTimestamp) * 1000 || Date.now(),
        from_me: fromMe,
        remote_jid: gwJid,
        push_name: m.pushName,
        message_stub_type: m.messageStubType,
        // on garde brut aussi pour le webhook côté DB
        raw: m
      }
      postWebhook(sess, {
        event: fromMe ? 'message.outgoing' : 'message.incoming',
        session_id: sess.id,
        org_id: sess.orgId,
        jid: gwJid,
        payload: normalized
      })
    }
  })

  return sess
}

// ---------------- HTTP
const app = express()
app.use(cors())
app.use(express.json({ limit: '15mb' }))
app.use(pinoHttp())

app.get('/health', (_req, res) => res.json({ ok: true }))

app.post('/sessions/:id/start', async (req, res) => {
  const { id } = req.params
  const { webhookUrl, webhookSecret, org_id } = req.body || {}
  try {
    const s = await createSession(id, webhookUrl, webhookSecret, org_id)
    res.json({ ok: true, session_id: id, status: s.status })
  } catch (e: any) {
    req.log?.error(e)
    res.status(500).json({ ok: false, error: 'start_failed', detail: String(e?.message || e) })
  }
})

app.get('/sessions/:id/sse', async (req, res) => {
  const { id } = req.params
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  // @ts-ignore
  res.flushHeaders?.()

  const s = sessions.get(id) || (await createSession(id))
  s.sse.add(res)

  res.write(`event: status\ndata: ${JSON.stringify({ status: s.status })}\n\n`)
  if (s.status === 'qr' && s.lastQr) {
    res.write(`event: qr\ndata: ${JSON.stringify({ qr: s.lastQr })}\n\n`)
  }

  req.on('close', () => s.sse.delete(res))
})

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
  console.log(JSON.stringify({ level: 30, time: Date.now(), app: 'Zuria.AI', port: PORT, authDir: '.baileys_auth', msg: 'Gateway listening' }))
})
