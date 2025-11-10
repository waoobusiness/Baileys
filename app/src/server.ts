// src/server.ts
import 'dotenv/config'
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import pino from 'pino'
import { Boom } from '@hapi/boom'
import {
  WASocket,
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WAMessageKey,
  jidDecode,
  proto,
  // Types récents Baileys
  IMessage,
  IMessageKey,
} from '@whiskeysockets/baileys'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'

/* ------------------------- logger & app ------------------------- */
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })
const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

/* --------------------------- security -------------------------- */
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'MY_PRIVATE_FURIA_API_KEY_2025'
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const hdr = (req.headers['authorization'] || '').toString()
  const got = hdr.startsWith('Bearer ') ? hdr.slice(7) : ''
  if (!got || got !== AUTH_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  next()
}

/* ------------------------ WA in-memory data --------------------- */
let sock: WASocket | null = null
const AUTH_DIR = path.join(process.cwd(), 'auth')

// in-memory
type Contact = { id: string; name?: string; notify?: string; verifiedName?: string; isBusiness?: boolean }
type Chat    = { jid: string; name?: string; unreadCount?: number; lastMsgTs?: number }

const contactsMap = new Map<string, Contact>()
const chatsMap    = new Map<string, Chat>()
// on garde volontairement any pour rester compatible avec les changements de types Baileys
const msgMap      = new Map<string, any[]>() // par jid, derniers messages

const MSG_CAP = 200
let currentQR: string | null = null
let qrStatus: 'idle' | 'pending' | 'open' | 'closed' = 'idle'

/* --------------------------- helpers ---------------------------- */
function toJid(input: string): string {
  if (!input) throw new Error('destination manquante')
  const s = input.trim()
  if (s.endsWith('@s.whatsapp.net') || s.endsWith('@g.us')) return s
  const num = s.replace(/\D/g, '')
  if (!num) throw new Error('numéro invalide')
  return `${num}@s.whatsapp.net`
}

function pushMessage(m: any) {
  const jid = m?.key?.remoteJid || ''
  if (!jid) return
  const arr = msgMap.get(jid) || []
  arr.push(m)
  if (arr.length > MSG_CAP) arr.splice(0, arr.length - MSG_CAP)
  msgMap.set(jid, arr)
}

async function resetAuthFolder() {
  try { await fsp.rm(AUTH_DIR, { recursive: true, force: true }) } catch {}
  await fsp.mkdir(AUTH_DIR, { recursive: true })
}

/* ----------------------- WA connection flow --------------------- */
async function connectWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()
  logger.info({ version }, 'Using WhatsApp version')

  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    browser: ['Zuria.AI', 'Chrome', '1.0.0'],
    auth: state,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldIgnoreJid: () => false,
    // Adapter la signature aux derniers types IMessage/IMessageKey
    getMessage: async (key: IMessageKey): Promise<IMessage | undefined> => {
      const jid = key.remoteJid || ''
      const arr = msgMap.get(jid) || []
      const found = arr.find((m: any) => m?.key?.id === key.id)
      return (found as unknown as IMessage) ?? undefined
    },
  })

  // on typage-relax "any" pour rester compatibles avec les nouvelles versions
  const ev: any = sock.ev

  /* ---------- persist creds ---------- */
  ev.on('creds.update', saveCreds)

  /* ---------- contacts/chats bootstrap ---------- */
  ev.on('contacts.set', ({ contacts }: any) => {
    for (const c of contacts || []) {
      if (!c?.id) continue
      contactsMap.set(c.id, {
        id: c.id,
        name: c.name,
        notify: c.notify,
        verifiedName: c.verifiedName,
        isBusiness: c.isBusiness,
      })
    }
  })
  ev.on('contacts.update', (updates: any[]) => {
    for (const u of updates || []) {
      if (!u?.id) continue
      const prev = contactsMap.get(u.id) || { id: u.id }
      contactsMap.set(u.id, { ...prev, ...u })
    }
  })
  ev.on('chats.set', ({ chats, isLatest }: any) => {
    for (const c of chats || []) {
      chatsMap.set(c.id, {
        jid: c.id,
        name: c.name,
        unreadCount: c.unreadCount,
        lastMsgTs: c.lastMsgRecv,
      })
    }
    logger.info({ count: (chats || []).length, isLatest }, 'chats.set')
  })
  ev.on('chats.upsert', (chs: any[]) => {
    for (const c of chs || []) {
      chatsMap.set(c.id, {
        jid: c.id,
        name: c.name,
        unreadCount: c.unreadCount,
        lastMsgTs: c.lastMsgRecv,
      })
    }
  })
  ev.on('chats.update', (chs: any[]) => {
    for (const c of chs || []) {
      const prev = chatsMap.get(c.id) || { jid: c.id }
      chatsMap.set(c.id, { ...prev, name: c.name ?? prev.name })
    }
  })

  /* ---------- messages ---------- */
  ev.on('messages.set', ({ chats, messages, isLatest }: any) => {
    for (const m of messages || []) pushMessage(m)
    logger.info({ chats: (chats || []).length, messages: (messages || []).length, isLatest }, 'messages.set')
  })
  ev.on('messages.upsert', ({ messages }: any) => {
    for (const m of messages || []) pushMessage(m)
  })
  ev.on('messages.update', (updates: any[]) => {
    for (const u of updates || []) {
      const jid = u?.key?.remoteJid || ''
      const arr = msgMap.get(jid)
      if (!arr) continue
      const idx = arr.findIndex((m: any) => m?.key?.id === u?.key?.id)
      if (idx >= 0) arr[idx] = { ...arr[idx], ...u }
    }
  })

  /* ---------- connection lifecycle ---------- */
  ev.on('connection.update', async (u: any) => {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      currentQR = qr
      qrStatus = 'pending'
      logger.info('QR ready')
    }

    if (connection === 'open') {
      logger.info('WhatsApp connection OPEN')
      qrStatus = 'open'
      currentQR = null
      return
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      logger.warn({ code, reason: DisconnectReason[code as any] }, 'connection closed')

      // 515 = restart required -> reconnect sans wipe
      if (code === 515 || code === DisconnectReason.restartRequired) {
        logger.warn('Restart required — reconnecting (no auth reset)')
        setTimeout(connectWA, 500)
        return
      }

      // 401/loggedOut -> wipe & restart
      if (code === 401 || code === DisconnectReason.loggedOut) {
        logger.error('Logged out — resetting auth & restarting')
        await resetAuthAndRestart()
        return
      }

      // autres -> tentative de reconnexion
      setTimeout(connectWA, 1000)
    }
  })
}

async function resetAuthAndRestart() {
  try { if (sock) await sock.logout() } catch {}
  await resetAuthFolder()
  currentQR = null
  qrStatus = 'pending'
  await connectWA()
}

/* ----------------------------- routes --------------------------- */
app.get('/health', (_req, res) => {
  res.json({ ok: true, status: qrStatus, connected: Boolean(sock?.user), user: sock?.user || null })
})

app.get('/qr', (_req, res) => {
  if (qrStatus === 'open') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(`
      <html><head><meta charset="utf-8"><title>WA QR</title>
      <style>body{font-family:system-ui,Arial;padding:24px}img{border:8px solid #eee;border-radius:16px}</style>
      </head><body>
      <h1>Déjà lié ✅</h1>
      <p>Status: open</p>
      </body></html>
    `)
  }
  const q = currentQR ? encodeURIComponent(currentQR) : ''
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`
    <html><head><meta charset="utf-8"><title>WA QR</title>
    <style>body{font-family:system-ui,Arial;padding:24px}img{border:8px solid #eee;border-radius:16px}</style>
    </head><body>
      <h1>Scanne avec WhatsApp</h1>
      ${currentQR ? `<img width="320" height="320" src="https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${q}" />`
                   : `<p>QR non prêt…</p>`}
      <p>Status: ${qrStatus}</p>
    </body></html>
  `)
})

app.get('/qr/json', (_req, res) => {
  res.json({ status: qrStatus, qr: currentQR })
})

app.post('/session/reset', requireAuth, async (_req, res) => {
  await resetAuthAndRestart()
  res.json({ ok: true })
})

app.post('/session/reconnect', requireAuth, async (_req, res) => {
  connectWA()
  res.json({ ok: true })
})

/* --------- sending: text / image / audio / PTT / reaction ------ */
app.post('/send-text', requireAuth, async (req, res) => {
  try {
    const jid = toJid(req.body.to)
    const text = (req.body.text || '').toString()
    if (!sock) throw new Error('socket not ready')
    await sock.sendMessage(jid, { text })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

app.post('/send-image', requireAuth, async (req, res) => {
  try {
    const jid = toJid(req.body.to)
    const url = (req.body.url || '').toString()
    const caption = (req.body.caption || '').toString()
    if (!sock) throw new Error('socket not ready')
    await sock.sendMessage(jid, { image: { url }, caption })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

app.post('/send-audio', requireAuth, async (req, res) => {
  try {
    const jid = toJid(req.body.to)
    const url = (req.body.url || '').toString()
    if (!sock) throw new Error('socket not ready')
    await sock.sendMessage(jid, { audio: { url }, mimetype: 'audio/mpeg' })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

app.post('/send-ptt', requireAuth, async (req, res) => {
  try {
    const jid = toJid(req.body.to)
    const url = (req.body.url || '').toString()
    if (!sock) throw new Error('socket not ready')
    await sock.sendMessage(jid, { audio: { url }, ptt: true, mimetype: 'audio/ogg' })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

app.post('/react', requireAuth, async (req, res) => {
  try {
    if (!sock) throw new Error('socket not ready')
    const jid = toJid(req.body.jid)
    const id = (req.body.id || '').toString()
    const emoji = (req.body.emoji || '').toString()
    const participant = (req.body.participant || '').toString() || undefined
    const key: WAMessageKey = { id, remoteJid: jid, fromMe: false, participant }
    await sock.sendMessage(jid, { react: { text: emoji, key } })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

/* ---------------------- data listing APIs ---------------------- */
app.get('/contacts', requireAuth, (_req, res) => {
  const contacts = Array.from(contactsMap.values())
  res.json({ count: contacts.length, contacts })
})

app.get('/chats', requireAuth, (_req, res) => {
  const chats = Array.from(chatsMap.values())
  res.json({ count: chats.length, chats })
})

app.get('/messages', requireAuth, async (req, res) => {
  try {
    const jid = toJid((req.query.jid || '').toString())
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 200))
    const arr = (msgMap.get(jid) || []).slice(-limit)
    res.json({ jid, count: arr.length, messages: arr })
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

/* ---------------------------- start ---------------------------- */
const PORT = Number(process.env.PORT || 10000)
app.listen(PORT, () => logger.info(`HTTP server listening on :${PORT}`))
connectWA().catch(err => logger.error(err, 'connectWA failed'))
