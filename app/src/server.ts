import express, { Request, Response } from "express"
import cors from "cors"
import http from "node:http"
import { EventEmitter } from "node:events"
import { randomUUID, createHash } from "node:crypto"
import pino from "pino"
import fse from "fs-extra"
import path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import { lookup as mimeLookup } from "mime-types"
import LRUCache from "lru-cache"

// Baileys
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
  Browsers,
  WAMessage,
  ConnectionState
} from "@whiskeysockets/baileys"

// ──────────────────────────────────────────────────────────────────────────────
// Basics
// ──────────────────────────────────────────────────────────────────────────────
const app = express()
app.use(cors())
app.use(express.json({ limit: "2mb" }))

const PORT = Number(process.env.PORT || 3000)
const DATA_DIR = process.env.WA_DATA_DIR || path.join(process.cwd(), "data", "wa-sessions")

const log = pino({ level: process.env.LOG_LEVEL || "info" })

// ──────────────────────────────────────────────────────────────────────────────
// Multi-tenant event bus (par orgId) + clients SSE
// ──────────────────────────────────────────────────────────────────────────────
type OrgId = string
type EventType = "status" | "qr" | "connection_info" | "error" | "log" | "custom" | "media"

interface InboundEvent {
  orgId: OrgId
  type: EventType
  data?: unknown
}

interface Client { id: string; res: Response }

const orgBuses = new Map<OrgId, EventEmitter>()
const orgClients = new Map<OrgId, Set<Client>>()

function getBus(orgId: OrgId): EventEmitter {
  let bus = orgBuses.get(orgId)
  if (!bus) {
    bus = new EventEmitter()
    bus.setMaxListeners(1000)
    orgBuses.set(orgId, bus)
  }
  return bus
}

function getClients(orgId: OrgId): Set<Client> {
  let set = orgClients.get(orgId)
  if (!set) {
    set = new Set<Client>()
    orgClients.set(orgId, set)
  }
  return set
}

// ──────────────────────────────────────────────────────────────────────────────
// SSE helpers
// ──────────────────────────────────────────────────────────────────────────────
function sseHeaders(res: Response) {
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache, no-transform")
  res.setHeader("Connection", "keep-alive")
  res.setHeader("X-Accel-Buffering", "no")
  res.flushHeaders?.()
}
function sseSend(res: Response, event: string, data: unknown) {
  const payload = typeof data === "string" ? data : JSON.stringify(data ?? {})
  res.write(`event: ${event}\n`)
  res.write(`data: ${payload}\n\n`)
}
function ssePing(res: Response) {
  res.write(`event: ping\n`)
  res.write(`data: "💓"\n\n`)
}

// ──────────────────────────────────────────────────────────────────────────────
// Health
// ──────────────────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    orgs: [...orgBuses.keys()].length,
    clients: [...orgClients.values()].reduce((acc, set) => acc + set.size, 0)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// SSE endpoint — /sse?org_id=xxx
// ──────────────────────────────────────────────────────────────────────────────
app.get("/sse", (req: Request, res: Response) => {
  const orgId = (req.query.org_id as string) || (req.query.orgId as string)
  if (!orgId) return res.status(400).json({ ok: false, error: "Missing org_id" })

  sseHeaders(res)
  const clientId = randomUUID()
  getClients(orgId).add({ id: clientId, res })
  sseSend(res, "welcome", { clientId, orgId, at: new Date().toISOString() })

  const bus = getBus(orgId)
  const on = (type: EventType, data: unknown) => sseSend(res, type, data)
  const onStatus = (d: unknown) => on("status", d)
  const onQR = (d: unknown) => on("qr", d)
  const onConn = (d: unknown) => on("connection_info", d)
  const onErr = (d: unknown) => on("error", d)
  const onLog = (d: unknown) => on("log", d)
  const onCustom = (d: unknown) => on("custom", d)
  const onMedia = (d: unknown) => on("media", d)

  bus.on("status", onStatus)
  bus.on("qr", onQR)
  bus.on("connection_info", onConn)
  bus.on("error", onErr)
  bus.on("log", onLog)
  bus.on("custom", onCustom)
  bus.on("media", onMedia)

  const heartbeat = setInterval(() => ssePing(res), 15000)

  req.on("close", () => {
    clearInterval(heartbeat)
    bus.off("status", onStatus)
    bus.off("qr", onQR)
    bus.off("connection_info", onConn)
    bus.off("error", onErr)
    bus.off("log", onLog)
    bus.off("custom", onCustom)
    bus.off("media", onMedia)
    const set = getClients(orgId)
    for (const c of set) if (c.id === clientId) set.delete(c)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Émission manuelle (debug) — GET /debug/emit?org_id=...&type=status&data=...
// ──────────────────────────────────────────────────────────────────────────────
app.get("/debug/emit", (req, res) => {
  const orgId = (req.query.org_id as string) || (req.query.orgId as string)
  const type = (req.query.type as EventType) || "log"
  const raw = req.query.data
  let data: unknown = raw
  try {
    if (typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("["))) data = JSON.parse(raw)
  } catch {}
  if (!orgId) return res.status(400).json({ ok: false, error: "Missing org_id" })
  getBus(orgId).emit(type, data ?? { ok: true })
  res.json({ ok: true, sent: { orgId, type, data } })
})

// ──────────────────────────────────────────────────────────────────────────────
// Baileys session manager (multi-org)
// ──────────────────────────────────────────────────────────────────────────────
type WASession = {
  orgId: OrgId
  sock: ReturnType<typeof makeWASocket>
  saveCreds: () => Promise<void>
}
const sessions = new Map<OrgId, WASession>()

async function ensureDir(dir: string) {
  await fse.mkdirp(dir)
}

function mediaKey(orgId: OrgId, msgId: string) {
  return `${orgId}:${msgId}`
}

type MediaItem = {
  buffer: Buffer
  mime: string
  filename: string
  size: number
  sha256: string
  ts: number
}
const mediaCache = new LRUCache<string, MediaItem>({
  max: 200,                 // jusqu'à 200 médias en RAM
  ttl: 1000 * 60 * 60       // 1 heure
})

async function startWhatsApp(orgId: OrgId) {
  if (sessions.has(orgId)) return sessions.get(orgId)!

  const orgPath = path.join(DATA_DIR, orgId)
  await ensureDir(orgPath)

  const { state, saveCreds } = await useMultiFileAuthState(orgPath)
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.appropriate("ZuriaCars"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    emitOwnEvents: false,
    logger: log
  })

  // Connexion
  sock.ev.on("connection.update", (u) => {
    const { connection, qr, lastDisconnect } = u as ConnectionState & { qr?: string }
    if (qr) {
      getBus(orgId).emit("qr", { orgId, qr, at: new Date().toISOString() })
      getBus(orgId).emit("status", { orgId, state: "qr", at: new Date().toISOString() })
    }
    if (connection === "open") {
      getBus(orgId).emit("status", { orgId, state: "connected", at: new Date().toISOString() })
      getBus(orgId).emit("connection_info", { orgId, me: sock.user, at: new Date().toISOString() })
      log.info({ orgId }, "WA connected")
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as any)?.output?.statusCode
      const reason = (lastDisconnect?.error as any)?.message || code
      getBus(orgId).emit("status", { orgId, state: "disconnected", reason, at: new Date().toISOString() })
      log.warn({ orgId, reason }, "WA disconnected")
      if (code !== DisconnectReason.loggedOut) {
        // tentative de reconnexion simple
        setTimeout(() => startWhatsApp(orgId).catch(err => log.error({ err }, "reconnect error")), 2000)
      }
    }
  })

  // Sauvegarde des creds
  sock.ev.on("creds.update", saveCreds)

  // Messages entrants — on intercepte les médias, on les télécharge et on les expose
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        await maybeCaptureMedia(orgId, msg)
      } catch (err) {
        log.error({ err }, "media capture error")
      }
    }
  })

  const session = { orgId, sock, saveCreds }
  sessions.set(orgId, session)
  return session
}

async function stopWhatsApp(orgId: OrgId, { erase = false } = {}) {
  const s = sessions.get(orgId)
  if (!s) return
  try { await s.sock.logout() } catch {}
  sessions.delete(orgId)
  if (erase) {
    const orgPath = path.join(DATA_DIR, orgId)
    try { await fse.remove(orgPath) } catch {}
  }
}

// Détecte, télécharge, cache et notifie la présence d’un média
async function maybeCaptureMedia(orgId: OrgId, msg: WAMessage) {
  const m = msg.message
  if (!m) return

  type Kind = "image" | "video" | "audio" | "document" | "sticker"
  let kind: Kind | null = null
  let node: any

  if (m.imageMessage) { kind = "image"; node = m.imageMessage }
  else if (m.videoMessage) { kind = "video"; node = m.videoMessage }
  else if (m.audioMessage) { kind = "audio"; node = m.audioMessage }
  else if (m.documentMessage) { kind = "document"; node = m.documentMessage }
  else if (m.stickerMessage) { kind = "sticker"; node = m.stickerMessage }

  if (!kind || !node) return

  const stream = await downloadContentFromMessage(node, kind)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const buffer = Buffer.concat(chunks)

  // Métadonnées
  const detected = await fileTypeFromBuffer(buffer)
  const declaredMime = node.mimetype as string | undefined
  const mime = declaredMime || detected?.mime || "application/octet-stream"
  const size = buffer.length
  const sha256 = createHash("sha256").update(buffer).digest("hex")
  const ts = Date.now()

  // Nom de fichier
  const suggested = (node.fileName as string | undefined) || (node.caption as string | undefined)
  const extFromMime = (mime && mimeLookup(mime)) ? `.${(mimeLookup(mime) as string).split("/").pop()}` : (detected?.ext ? `.${detected.ext}` : "")
  const filename = sanitizeFilename(suggested) || `${kind}-${msg.key.id}${extFromMime || ""}`

  const key = mediaKey(orgId, msg.key.id!)
  mediaCache.set(key, { buffer, mime, filename, size, sha256, ts })

  // Notifie le front via SSE
  getBus(orgId).emit("media", {
    orgId,
    msgId: msg.key.id,
    from: msg.key.remoteJid,
    kind,
    mime,
    size,
    sha256,
    filename,
    url: `/media/${encodeURIComponent(orgId)}/${encodeURIComponent(msg.key.id!)}`
  })
}

function sanitizeFilename(name?: string): string | undefined {
  if (!name) return undefined
  return name.replace(/[^\w\-.]+/g, "_").slice(0, 120)
}

// ──────────────────────────────────────────────────────────────────────────────
// API WhatsApp — démarrer/arrêter et infos
// ──────────────────────────────────────────────────────────────────────────────
app.post("/wa/start", async (req, res) => {
  const orgId = (req.body?.orgId as string) || ""
  if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" })
  try {
    await startWhatsApp(orgId)
    return res.json({ ok: true, orgId })
  } catch (err) {
    log.error({ err }, "wa/start error")
    return res.status(500).json({ ok: false, error: "WA start failed" })
  }
})

app.post("/wa/logout", async (req, res) => {
  const orgId = (req.body?.orgId as string) || ""
  const erase = Boolean(req.body?.erase)
  if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" })
  try {
    await stopWhatsApp(orgId, { erase })
    getBus(orgId).emit("status", { orgId, state: "logged_out" })
    return res.json({ ok: true })
  } catch (err) {
    log.error({ err }, "wa/logout error")
    return res.status(500).json({ ok: false, error: "WA logout failed" })
  }
})

app.get("/wa/status", async (req, res) => {
  const orgId = (req.query.org_id as string) || (req.query.orgId as string) || ""
  if (!orgId) return res.status(400).json({ ok: false, error: "Missing org_id" })
  const sess = sessions.get(orgId)
  res.json({
    ok: true,
    orgId,
    connected: Boolean(sess?.sock?.user),
    user: sess?.sock?.user || null
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// MEDIA — Streaming HTTP direct depuis le cache (TTL 1h par défaut)
// GET /media/:orgId/:msgId
// ──────────────────────────────────────────────────────────────────────────────
app.get("/media/:orgId/:msgId", async (req, res) => {
  const orgId = req.params.orgId
  const msgId = req.params.msgId
  const item = mediaCache.get(mediaKey(orgId, msgId))
  if (!item) return res.status(404).json({ ok: false, error: "Not found or expired" })

  res.setHeader("Content-Type", item.mime)
  res.setHeader("Content-Length", String(item.size))
  res.setHeader("Content-Disposition", `inline; filename="${item.filename}"`)
  res.send(item.buffer)
})

// ──────────────────────────────────────────────────────────────────────────────
// EVENTS ingress (optionnel) — permet d’émettre manuellement des events SSE
// ──────────────────────────────────────────────────────────────────────────────
app.post("/events", (req: Request<unknown, unknown, InboundEvent>, res: Response) => {
  const { orgId, type, data } = req.body || {}
  if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" })
  if (!type) return res.status(400).json({ ok: false, error: "Missing type" })
  getBus(orgId).emit(type, data ?? {})
  res.json({ ok: true })
})

// ──────────────────────────────────────────────────────────────────────────────
// Server
// ──────────────────────────────────────────────────────────────────────────────
await fse.mkdirp(DATA_DIR)
const server = http.createServer(app)
server.listen(PORT, () => log.info(`[server] listening on :${PORT}`))

function shutdown(signal: NodeJS.Signals) {
  log.warn(`[server] ${signal} received, shutting down…`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
