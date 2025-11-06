// src/server.ts
import express from "express"
import pino from "pino"
import {
  default as makeWASocket,
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys"
import fs from "node:fs"
import path from "node:path"

// ---------- Config ----------
const logger = pino({ level: process.env.LOG_LEVEL || "info" })
const API_KEY = process.env.API_KEY || process.env.GATEWAY_API_KEY || "MY_PRIVATE_FURIA_API_KEY_2025"

// Disque persistant Render: monte ton Disk sur /data
const DATA_DIR = process.env.DATA_DIR || "/data" // ex: /data
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID || "default"
const PORT = Number(process.env.PORT || 3001)

type SessionCtx = {
  id: string
  authDir: string
  mediaDir: string
  sock: any | null
  saveCreds?: () => Promise<void>
  qr?: string | null
  qrAt?: number
  starting?: boolean
}

const sessions = new Map<string, SessionCtx>()

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function sanitizePhone(input: string) {
  return (input || "").replace(/\D+/g, "")
}

// ---------- Boot ----------
ensureDir(DATA_DIR)
logger.info({ DATA_DIR, AUTH_DIR: path.join(DATA_DIR, "auth_info_baileys"), MEDIA_DIR: path.join(DATA_DIR, "media") }, "paths ready")

// ---------- Express ----------
const app = express()
app.use(express.json({ limit: "2mb" }))

// auth simple par x-api-key (et fallback ?key=...)
function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.headers["x-api-key"] || (req.query.key as string)
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" })
  }
  next()
}

// ---------- WA session factory ----------
async function startSocket(sessionId: string): Promise<SessionCtx> {
  let ctx = sessions.get(sessionId)
  if (ctx?.starting) return ctx
  if (!ctx) {
    const authDir = path.join(DATA_DIR, sessionId, "auth_info_baileys")
    const mediaDir = path.join(DATA_DIR, sessionId, "media")
    ensureDir(authDir)
    ensureDir(mediaDir)
    ctx = { id: sessionId, authDir, mediaDir, sock: null, qr: null, qrAt: undefined, starting: false }
    sessions.set(sessionId, ctx)
  }

  if (ctx.sock) return ctx
  ctx.starting = true

  const { state, saveCreds } = await useMultiFileAuthState(ctx.authDir)

  const sock = makeWASocket({
    auth: state,
    // IMPORTANT pour récupérer un historique plus profond
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    // plus de QR auto dans les logs (déprécié de toute façon)
    printQRInTerminal: false,
  })

  ctx.sock = sock
  ctx.saveCreds = saveCreds

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u as any
    if (qr) {
      ctx!.qr = qr
      ctx!.qrAt = Date.now()
      logger.info({ sessionId, qrAt: ctx!.qrAt }, "QR updated")
    }
    if (connection === "open") {
      logger.info({ sessionId }, "✅ WhatsApp socket OPEN")
      ctx!.qr = null
    }
    if (connection === "close") {
      const code = (lastDisconnect as any)?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      logger.warn({ sessionId, code, shouldReconnect }, "WS closed")
      ctx!.sock = null
      if (shouldReconnect) {
        // petit backoff
        setTimeout(() => startSocket(sessionId).catch(() => {}), 2000)
      }
    }
  })

  // petit echo pour tests
  sock.ev.on("messages.upsert", async (ev: any) => {
    for (const m of ev.messages || []) {
      if (!m.key?.fromMe && m.key?.remoteJid) {
        try {
          await sock.sendMessage(m.key.remoteJid, { text: "Hello from Zuria 🤖" })
        } catch {}
      }
    }
  })

  ctx.starting = false
  return ctx
}

// ---------- Routes publiques minimes ----------
app.get("/", (_req, res) => res.send("ok"))
app.get("/health", (_req, res) => res.json({ ok: true }))

// ---------- QR par défaut (fallback simple) ----------
app.get("/qr", requireApiKey, async (req, res) => {
  const sessionId = (req.query.sessionId as string) || DEFAULT_SESSION_ID
  const ctx = await startSocket(sessionId)
  if (ctx.qr) return res.json({ sessionId, qr: ctx.qr })
  return res.status(404).json({ error: "no-qr-available" })
})

// ---------- API protégée ----------
app.use(requireApiKey)

// Créer / démarrer une session
app.post("/sessions", async (req, res) => {
  try {
    const sessionId: string = (req.body?.sessionId || "").trim() || DEFAULT_SESSION_ID
    const ctx = await startSocket(sessionId)
    const isConnected = !!ctx.sock?.user
    return res.json({ ok: true, sessionId, status: isConnected ? "connected" : "connecting", isConnected })
  } catch (e: any) {
    logger.warn({ err: e }, "create session failed")
    return res.status(500).json({ error: e?.message || "create session failed" })
  }
})

// Statut session
app.get("/sessions/:id", async (req, res) => {
  try {
    const sessionId = req.params.id
    const ctx = await startSocket(sessionId)
    const me = ctx.sock?.user || null
    const isConnected = !!me
    return res.json({
      ok: true,
      sessionId,
      status: isConnected ? "connected" : "connecting",
      isConnected,
      me,
      phoneNumber: me?.id ? String(me.id).split(":")[0] : null,
      counts: {}, // placeholder
      qrAvailable: !!ctx.qr,
    })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "status failed" })
  }
})

// Récupérer le QR d'une session
app.get("/sessions/:id/qr", async (req, res) => {
  const sessionId = req.params.id
  const ctx = await startSocket(sessionId)
  if (ctx.qr) return res.json({ sessionId, qr: ctx.qr })
  return res.status(404).json({ error: "no-qr-available" })
})

// 🔐 Pairing code (connexion sans QR) — multi-sessions
app.post("/sessions/:id/pairing-code", async (req, res) => {
  try {
    const sessionId = req.params.id
    const phoneRaw: string = String(req.body?.phoneNumber || "")
    const customPair: string | undefined = req.body?.pair // optionnel, 8 alphanum

    const phone = sanitizePhone(phoneRaw)
    if (!phone) return res.status(400).json({ error: "phoneNumber is required (digits only, with country code)" })

    const ctx = await startSocket(sessionId)
    if (!ctx.sock) return res.status(503).json({ error: "socket not ready" })

    if (ctx.sock.authState?.creds?.registered) {
      return res.status(400).json({ error: "already registered/connected" })
    }

    // Baileys (whiskeysockets) accepte phone; certains forks acceptent (phone, customPair)
    let code: string
    try {
      if (customPair && /^[A-Za-z0-9]{8}$/.test(customPair)) {
        code = await (ctx.sock as any).requestPairingCode(phone, customPair)
      } else {
        code = await ctx.sock.requestPairingCode(phone)
      }
    } catch (err) {
      // fallback: si la signature (phone, custom) n'est pas supportée
      code = await ctx.sock.requestPairingCode(phone)
    }

    return res.json({ sessionId, pairingCode: code })
  } catch (e: any) {
    logger.warn({ err: e }, "pairing-code failed")
    return res.status(500).json({ error: e?.message || "pairing-code failed" })
  }
})

// Envoi message (multi-sessions)
app.post("/sessions/:id/messages/send", async (req, res) => {
  try {
    const sessionId = req.params.id
    const to = sanitizePhone(String(req.body?.to || ""))
    const text = String(req.body?.text || "")
    if (!to || !text) return res.status(400).json({ error: "to and text are required" })

    const ctx = await startSocket(sessionId)
    if (!ctx.sock?.user) return res.status(503).json({ error: "session not connected" })

    const jid = `${to}@s.whatsapp.net`
    const resp = await ctx.sock.sendMessage(jid, { text })
    return res.json({ ok: true, id: resp?.key?.id || null })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "send failed" })
  }
})

// (Optionnel) /send simple sur la session par défaut
app.post("/send", async (req, res) => {
  try {
    const to = sanitizePhone(String(req.body?.to || ""))
    const text = String(req.body?.text || "")
    if (!to || !text) return res.status(400).json({ error: "to and text are required" })

    const ctx = await startSocket(DEFAULT_SESSION_ID)
    if (!ctx.sock?.user) return res.status(503).json({ error: "session not connected" })

    const jid = `${to}@s.whatsapp.net`
    const resp = await ctx.sock.sendMessage(jid, { text })
    return res.json({ ok: true, id: resp?.key?.id || null })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "send failed" })
  }
})

// (Facultatif) liste de chats (light) — dépend de la synchro
app.get("/sessions/:id/chats", async (req, res) => {
  try {
    const sessionId = req.params.id
    const ctx = await startSocket(sessionId)
    if (!ctx.sock) return res.status(503).json({ error: "socket not ready" })

    // Baileys renvoie l'historique progressivement; on expose ce qu'on a via sock.store? (pas stable en v7)
    // Pour rester safe: renvoie juste si user connecté, sinon liste vide.
    const isConnected = !!ctx.sock.user
    return res.json({
      sessionId,
      connected: isConnected,
      count: 0,
      chats: [],
    })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "chats failed" })
  }
})

// ---------- Start ----------
app.listen(PORT, () => logger.info(`HTTP listening on :${PORT}`))
