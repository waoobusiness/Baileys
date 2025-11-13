import express, { Request, Response } from "express"
import cors from "cors"
import pino from "pino"
import fs from "fs-extra"
import path from "path"
import { LRUCache } from "lru-cache"
import { v4 as uuidv4 } from "uuid"
import { lookup as mimeLookup } from "mime-types"
import EventEmitter from "eventemitter3"
import QRCode from "qrcode"

// Baileys
import makeWASocket, {
  WASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  WAMessage,
  AnyMessageContent,
  downloadMediaMessage
} from "@whiskeysockets/baileys"

const logger = pino({ level: process.env.LOG_LEVEL || "info" })

// ----------- Config
const PORT = Number(process.env.PORT || 3000)
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(process.cwd(), "sessions")

// ----------- App
const app = express()
app.use(cors())
app.use(express.json({ limit: "25mb" }))
app.use(express.urlencoded({ extended: true, limit: "25mb" }))

// ----------- Types & Stores
type Session = {
  orgId: string
  sock?: WASocket
  saveCreds?: () => Promise<void>
  bus: EventEmitter
  qr?: string | null
  status: "starting" | "qr" | "connecting" | "connected" | "closed"
  msgCache: LRUCache<string, WAMessage>
}

const sessions = new Map<string, Session>()

function getBus(orgId: string) {
  let s = sessions.get(orgId)
  if (!s) {
    s = {
      orgId,
      bus: new EventEmitter(),
      status: "closed",
      qr: null,
      msgCache: new LRUCache<string, WAMessage>({ max: 1000 })
    }
    sessions.set(orgId, s)
  }
  return s.bus
}

function phoneToJid(to: string) {
  const digits = to.replace(/[^\d]/g, "").replace(/^00/, "")
  return `${digits}@s.whatsapp.net`
}

async function bufferFromInput(input?: { url?: string; base64?: string }) {
  if (!input) return undefined
  if (input.base64) {
    const comma = input.base64.indexOf(",")
    const b64 = comma >= 0 ? input.base64.slice(comma + 1) : input.base64
    return Buffer.from(b64, "base64")
  }
  if (input.url) {
    const r = await fetch(input.url)
    if (!r.ok) throw new Error(`fetch failed ${r.status}`)
    const arr = await r.arrayBuffer()
    return Buffer.from(arr)
  }
  return undefined
}

function getSessionOr404(orgId: string, res: Response): Session | null {
  const s = sessions.get(orgId)
  if (!s || !s.sock?.user) {
    res.status(400).json({ ok: false, error: "Session not connected" })
    return null
  }
  return s
}

// ----------- Session bootstrap
async function startSession(orgId: string) {
  let sess = sessions.get(orgId)
  if (sess?.sock && sess.status === "connected") return sess

  const authDir = path.join(SESSIONS_DIR, orgId)
  await fs.ensureDir(authDir)

  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()

  sess = sessions.get(orgId) || {
    orgId,
    bus: new EventEmitter(),
    status: "starting",
    qr: null,
    msgCache: new LRUCache<string, WAMessage>({ max: 1000 })
  }
  sessions.set(orgId, sess)

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: ["Zuria", "Chrome", "1.0.0"],
    logger
  })

  sess.sock = sock
  sess.saveCreds = saveCreds
  sess.status = "connecting"
  sess.qr = null

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      sess!.qr = qr
      sess!.status = "qr"
      getBus(orgId).emit("status", { type: "qr", qr })
    }
    if (connection === "open") {
      sess!.status = "connected"
      sess!.qr = null
      getBus(orgId).emit("status", { type: "connected", user: sock.user })
      logger.info({ orgId }, "WA connected")
    }
    if (connection === "close") {
      const code = (lastDisconnect as any)?.error?.output?.statusCode
      // IMPORTANT: deviceRemoved n'existe pas dans cette version.
      // On évite la reconnexion automatique seulement pour loggedOut & badSession.
      const willReconnect =
        code !== DisconnectReason.loggedOut &&
        code !== DisconnectReason.badSession
      sess!.status = "closed"
      getBus(orgId).emit("status", { type: "closed", code, willReconnect })
      logger.warn({ orgId, code, willReconnect }, "WA closed")
      // Ici tu peux rebooter/recréer la socket si tu veux une reconnexion automatique.
      // Exemple:
      // if (willReconnect) setTimeout(() => startSession(orgId).catch(() => {}), 2000)
    }
  })

  // Messages in
  sock.ev.on("messages.upsert", (m) => {
    const up = m.messages || []
    for (const msg of up) {
      if (msg.key && msg.key.id) {
        sess!.msgCache.set(msg.key.id, msg)
      }
      getBus(orgId).emit("message", {
        type: "message",
        message: {
          id: msg.key.id,
          from: msg.key.remoteJid,
          fromMe: msg.key.fromMe,
          pushName: (msg as any).pushName,
          timestamp: (msg.messageTimestamp || 0).toString(),
          messageType: msg.message ? Object.keys(msg.message)[0] : undefined
        }
      })
    }
  })

  sock.ev.on("messages.update", (updates) => {
    getBus(orgId).emit("messages.update", updates)
  })

  sock.ev.on("message-receipt.update", (r) => {
    getBus(orgId).emit("receipt", r)
  })

  return sess
}

// ----------- SSE (événements temps réel)
app.get("/wa/sse", async (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || "")
  if (!orgId) return res.status(400).end("orgId required")

  req.socket.setTimeout(0)
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders()

  const bus = getBus(orgId)
  const send = (event: string, data: any) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  // Snapshot initial
  const s = sessions.get(orgId)
  send("hello", {
    orgId,
    status: s?.status || "closed",
    hasQR: Boolean(s?.qr),
    connected: Boolean(s?.sock?.user),
    user: s?.sock?.user || null
  })
  if (s?.qr) {
    const qrSvg = await QRCode.toString(s.qr, { type: "svg" })
    send("qr", { qr: s.qr, svg: qrSvg })
  }

  const onStatus = (data: any) => send("status", data)
  const onMessage = (data: any) => send("message", data)
  const onUpdate = (data: any) => send("messages.update", data)
  const onReceipt = (data: any) => send("receipt", data)

  bus.on("status", onStatus)
  bus.on("message", onMessage)
  bus.on("messages.update", onUpdate)
  bus.on("receipt", onReceipt)

  const interval = setInterval(() => res.write(": keep-alive\n\n"), 25000)

  req.on("close", () => {
    clearInterval(interval)
    bus.off("status", onStatus)
    bus.off("message", onMessage)
    bus.off("messages.update", onUpdate)
    bus.off("receipt", onReceipt)
  })
})

// ----------- Auth / Status
app.post("/wa/login", async (req: Request, res: Response) => {
  const { orgId } = req.body || {}
  if (!orgId) return res.status(400).json({ ok: false, error: "orgId required" })
  try {
    const s = await startSession(String(orgId))
    res.json({
      ok: true,
      status: s.status,
      hasQR: Boolean(s.qr),
      user: s.sock?.user || null
    })
  } catch (err) {
    logger.error(err)
    res.status(500).json({ ok: false, error: String(err) })
  }
})

app.get("/wa/status", async (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || "")
  if (!orgId) return res.status(400).json({ ok: false, error: "orgId required" })
  const s = sessions.get(orgId)
  res.json({
    ok: true,
    status: s?.status || "closed",
    hasQR: Boolean(s?.qr),
    user: s?.sock?.user || null,
    connected: Boolean(s?.sock?.user)
  })
})

app.get("/wa/qr", async (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || "")
  if (!orgId) return res.status(400).json({ ok: false, error: "orgId required" })
  const s = sessions.get(orgId)
  if (!s?.qr) return res.status(404).json({ ok: false, error: "No pending QR" })
  const svg = await QRCode.toString(s.qr, { type: "svg" })
  res.json({ ok: true, qr: s.qr, svg })
})

app.post("/wa/logout", async (req: Request, res: Response) => {
  const { orgId } = req.body || {}
  if (!orgId) return res.status(400).json({ ok: false, error: "orgId required" })
  const s = sessions.get(orgId)
  try {
    await s?.sock?.logout()
  } catch (e) {
    logger.warn({ e }, "logout error (ignored)")
  }
  sessions.delete(orgId)
  // Pour reset total: décommente si tu veux supprimer la session disque
  // await fs.remove(path.join(SESSIONS_DIR, orgId))
  res.json({ ok: true })
})

// ----------- ENVOI DE MESSAGES
app.post("/wa/send/text", async (req: Request, res: Response) => {
  const { orgId, to, text, quotedMsgId, mentions } = req.body || {}
  if (!orgId || !to || !text) return res.status(400).json({ ok: false, error: "orgId,to,text required" })
  const s = getSessionOr404(String(orgId), res); if (!s) return
  try {
    const jid = phoneToJid(String(to))
    const options: any = {}
    if (quotedMsgId) options.quoted = { key: { id: quotedMsgId, fromMe: false, remoteJid: jid } }
    const content: AnyMessageContent = { text: String(text) }
    if (Array.isArray(mentions) && mentions.length) (content as any).mentions = mentions.map((p: string) => phoneToJid(p))
    const sent = await s.sock!.sendMessage(jid, content, options)
    getBus(String(orgId)).emit("custom", { type: "message_sent", to: jid, kind: "text", key: sent.key })
    res.json({ ok: true, key: sent.key })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

app.post("/wa/send/image", async (req: Request, res: Response) => {
  const { orgId, to, caption, image } = req.body || {}
  if (!orgId || !to || !image) return res.status(400).json({ ok: false, error: "orgId,to,image required" })
  const s = getSessionOr404(String(orgId), res); if (!s) return
  try {
    const jid = phoneToJid(String(to))
    const buf = await bufferFromInput(image)
    const msg: AnyMessageContent = buf ? { image: buf, caption } : { image: { url: image.url }, caption }
    const sent = await s.sock!.sendMessage(jid, msg)
    getBus(String(orgId)).emit("custom", { type: "message_sent", to: jid, kind: "image", key: sent.key })
    res.json({ ok: true, key: sent.key })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

app.post("/wa/send/document", async (req: Request, res: Response) => {
  const { orgId, to, fileName, mimetype, document } = req.body || {}
  if (!orgId || !to || !document) return res.status(400).json({ ok: false, error: "orgId,to,document required" })
  const s = getSessionOr404(String(orgId), res); if (!s) return
  try {
    const jid = phoneToJid(String(to))
    const buf = await bufferFromInput(document)
    const msg: AnyMessageContent = buf
      ? { document: buf, fileName: fileName || "file", mimetype }
      : { document: { url: document.url }, fileName: fileName || "file", mimetype }
    const sent = await s.sock!.sendMessage(jid, msg)
    getBus(String(orgId)).emit("custom", { type: "message_sent", to: jid, kind: "document", key: sent.key })
    res.json({ ok: true, key: sent.key })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

app.post("/wa/send/audio", async (req: Request, res: Response) => {
  const { orgId, to, ptt, audio } = req.body || {}
  if (!orgId || !to || !audio) return res.status(400).json({ ok: false, error: "orgId,to,audio required" })
  const s = getSessionOr404(String(orgId), res); if (!s) return
  try {
    const jid = phoneToJid(String(to))
    const buf = await bufferFromInput(audio)
    const msg: AnyMessageContent = buf ? { audio: buf, ptt: Boolean(ptt) } : { audio: { url: audio.url }, ptt: Boolean(ptt) }
    const sent = await s.sock!.sendMessage(jid, msg)
    getBus(String(orgId)).emit("custom", { type: "message_sent", to: jid, kind: "audio", key: sent.key })
    res.json({ ok: true, key: sent.key })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

app.post("/wa/send/buttons", async (req: Request, res: Response) => {
  const { orgId, to, text, footer, buttons } = req.body || {}
  if (!orgId || !to || !text || !Array.isArray(buttons)) {
    return res.status(400).json({ ok: false, error: "orgId,to,text,buttons required" })
  }
  const s = getSessionOr404(String(orgId), res); if (!s) return
  try {
    const jid = phoneToJid(String(to))
    const msg: AnyMessageContent = {
      text,
      footer,
      buttons: buttons.map((b: any, i: number) => ({
        buttonId: String(b.id ?? `btn_${i + 1}`),
        buttonText: { displayText: String(b.label ?? b.text ?? `Option ${i + 1}`) },
        type: 1
      })),
      headerType: 1
    } as any
    const sent = await s.sock!.sendMessage(jid, msg)
    getBus(String(orgId)).emit("custom", { type: "message_sent", to: jid, kind: "buttons", key: sent.key })
    res.json({ ok: true, key: sent.key })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

app.post("/wa/send/list", async (req: Request, res: Response) => {
  const { orgId, to, title, text, footer, buttonText, sections } = req.body || {}
  if (!orgId || !to || !text || !Array.isArray(sections)) {
    return res.status(400).json({ ok: false, error: "orgId,to,text,sections required" })
  }
  const s = getSessionOr404(String(orgId), res); if (!s) return
  try {
    const jid = phoneToJid(String(to))
    const msg: AnyMessageContent = {
      text,
      footer,
      title,
      buttonText: buttonText || "Choisir",
      sections: sections.map((sec: any) => ({
        title: String(sec.title || ""),
        rows: (sec.rows || []).map((r: any, i: number) => ({
          rowId: String(r.id ?? `row_${i + 1}`),
          title: String(r.title ?? `Option ${i + 1}`),
          description: r.description ? String(r.description) : undefined
        }))
      }))
    } as any
    const sent = await s.sock!.sendMessage(jid, msg)
    getBus(String(orgId)).emit("custom", { type: "message_sent", to: jid, kind: "list", key: sent.key })
    res.json({ ok: true, key: sent.key })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ----------- Lecture messages récents (et médias)
app.get("/wa/messages/recent", (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || "")
  const limit = Number(req.query.limit || 50)
  const s = sessions.get(orgId)
  if (!s) return res.status(404).json({ ok: false, error: "No session" })
  const out: any[] = []
  s.msgCache.forEach((msg, id) => {
    out.push({
      id,
      from: msg.key.remoteJid,
      fromMe: msg.key.fromMe,
      timestamp: (msg.messageTimestamp || 0).toString(),
      type: msg.message ? Object.keys(msg.message)[0] : undefined
    })
  })
  out.sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
  res.json({ ok: true, messages: out.slice(0, limit) })
})

app.post("/wa/media/download", async (req: Request, res: Response) => {
  const { orgId, msgId } = req.body || {}
  if (!orgId || !msgId) return res.status(400).json({ ok: false, error: "orgId,msgId required" })
  const s = getSessionOr404(String(orgId), res); if (!s) return
  const msg = s.msgCache.get(String(msgId))
  if (!msg) return res.status(404).json({ ok: false, error: "Message not in cache" })

  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: s.sock!.updateMediaMessage }
    )

    const m =
      (msg.message as any)?.imageMessage?.mimetype ||
      (msg.message as any)?.videoMessage?.mimetype ||
      (msg.message as any)?.documentMessage?.mimetype ||
      (msg.message as any)?.audioMessage?.mimetype ||
      mimeLookup("bin") ||
      "application/octet-stream"

    const base64 = buffer.toString("base64")
    res.json({ ok: true, mimetype: m, base64: `data:${m};base64,${base64}` })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ----------- Health
app.get("/health", (_req, res) => res.json({ ok: true, service: "zuria-baileys", ts: Date.now() }))

// ----------- Boot
async function main() {
  await fs.ensureDir(SESSIONS_DIR)
  app.listen(PORT, () => {
    logger.info(`HTTP listening on :${PORT}`)
  })
}
main().catch((e) => {
  logger.error(e)
  process.exit(1)
})
