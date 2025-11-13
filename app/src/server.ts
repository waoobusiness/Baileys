import express, { Request, Response } from "express"
import cors from "cors"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import http from "node:http"

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────
type OrgId = string

type EventType = "status" | "qr" | "connection_info" | "error" | "log" | "custom"

interface InboundEvent {
  orgId: OrgId
  type: EventType
  data?: unknown
}

interface Client {
  id: string
  res: Response
}

const app = express()
app.use(cors())
app.use(express.json({ limit: "1mb" }))

const PORT = Number(process.env.PORT || 3000)

// ──────────────────────────────────────────────────────────────────────────────
/**
 * Multi-tenant event bus :
 *  - Un EventEmitter par orgId
 *  - Une liste de clients SSE (Response) par orgId
 */
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
  res.setHeader("X-Accel-Buffering", "no") // utile sur certains proxies
  res.flushHeaders?.()
}

function sseSend(res: Response, event: string, data: unknown) {
  // Pas d'objets circulaires
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
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    orgs: [...orgBuses.keys()].length,
    clients: [...orgClients.values()].reduce((acc, set) => acc + set.size, 0)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// SSE endpoint — /sse?org_id=xxx
// Remplace l'ancien proxy "wa-sse-proxy" si besoin.
// ──────────────────────────────────────────────────────────────────────────────
app.get("/sse", (req: Request, res: Response) => {
  const orgId = (req.query.org_id as string) || (req.query.orgId as string)
  if (!orgId) {
    res.status(400).json({ ok: false, error: "Missing org_id" })
    return
  }

  sseHeaders(res)
  const clientId = randomUUID()
  const clients = getClients(orgId)
  clients.add({ id: clientId, res })

  // Message d’accueil
  sseSend(res, "welcome", { clientId, orgId, at: new Date().toISOString() })

  const bus = getBus(orgId)
  const onStatus = (data: unknown) => sseSend(res, "status", data)
  const onQR = (data: unknown) => sseSend(res, "qr", data)
  const onConn = (data: unknown) => sseSend(res, "connection_info", data)
  const onErr = (data: unknown) => sseSend(res, "error", data)
  const onLog = (data: unknown) => sseSend(res, "log", data)
  const onCustom = (data: unknown) => sseSend(res, "custom", data)

  bus.on("status", onStatus)
  bus.on("qr", onQR)
  bus.on("connection_info", onConn)
  bus.on("error", onErr)
  bus.on("log", onLog)
  bus.on("custom", onCustom)

  // Heartbeat pour garder la connexion en vie (proxy/Render)
  const heartbeat = setInterval(() => ssePing(res), 15000)

  req.on("close", () => {
    clearInterval(heartbeat)
    bus.off("status", onStatus)
    bus.off("qr", onQR)
    bus.off("connection_info", onConn)
    bus.off("error", onErr)
    bus.off("log", onLog)
    bus.off("custom", onCustom)

    const set = getClients(orgId)
    for (const c of set) if (c.id === clientId) set.delete(c)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
/**
 * Ingress events — POST /events
 * Permet à vos workers (WhatsApp/Baileys, webhooks, cron) d’émettre vers l’SSE.
 * Body: { orgId: string, type: "status"|"qr"|..., data?: any }
 */
app.post("/events", (req: Request<unknown, unknown, InboundEvent>, res: Response) => {
  const { orgId, type, data } = req.body || {}
  if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" })
  if (!type) return res.status(400).json({ ok: false, error: "Missing type" })

  const bus = getBus(orgId)
  bus.emit(type, data ?? {})

  res.json({ ok: true })
})

// ──────────────────────────────────────────────────────────────────────────────
// Utilitaires debug (à retirer en prod si besoin)
// GET /debug/emit?org_id=xxx&type=status&data=connected
// ──────────────────────────────────────────────────────────────────────────────
app.get("/debug/emit", (req, res) => {
  const orgId = (req.query.org_id as string) || (req.query.orgId as string)
  const type = (req.query.type as EventType) || "log"
  const raw = req.query.data
  let data: unknown = raw

  try {
    if (typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("["))) {
      data = JSON.parse(raw)
    }
  } catch {
    // keep raw string
  }

  if (!orgId) return res.status(400).json({ ok: false, error: "Missing org_id" })
  getBus(orgId).emit(type, data ?? { ok: true, note: "no data" })

  res.json({ ok: true, sent: { orgId, type, data } })
})

// ──────────────────────────────────────────────────────────────────────────────
// Server
// ──────────────────────────────────────────────────────────────────────────────
const server = http.createServer(app)

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`)
})

// Graceful shutdown
function shutdown(signal: NodeJS.Signals) {
  console.log(`[server] ${signal} received, shutting down…`)
  server.close(() => {
    console.log("[server] closed")
    process.exit(0)
  })
  // Force exit si quelque chose bloque
  setTimeout(() => process.exit(1), 5000).unref()
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
