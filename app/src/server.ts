import express from "express"
import pino from "pino"
import path from "node:path"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys"

type ChatLite = {
  id: string
  name?: string
  unreadCount?: number
  conversationTimestamp?: number
}

type ContactLite = {
  jid: string
  name?: string | null
  verifiedName?: string | null
  isBusiness?: boolean
  isEnterprise?: boolean
}

type MessageLite = {
  key: any
  message?: any
  messageTimestamp?: number
  pushName?: string
  fromMe?: boolean
}

type SessionData = {
  id: string
  authDir: string
  sock: any | null
  status: "connecting" | "connected" | "closed"
  qr?: string | null
  // caches in-memory (optionnel, à persister plus tard si besoin)
  chats: Map<string, ChatLite>
  contacts: Map<string, ContactLite>
  messagesByJid: Map<string, MessageLite[]>
}

const logger = pino({ level: process.env.LOG_LEVEL || "info" })

// IMPORTANT: sur Render, monte le disque sur /var/data
const DATA_DIR = process.env.DATA_DIR || "/var/data"
const API_KEY = process.env.API_KEY || process.env.FURIA_API_KEY || "MY_PRIVATE_FURIA_API_KEY_2025"

// session “par défaut” (pour compat avec /qr, /send)
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID || "default"

// port Render
const PORT = Number(process.env.PORT || 3001)

// ---------------------------
// State mémoire multi-sessions
// ---------------------------
const sessions = new Map<string, SessionData>()

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const incoming = req.header("x-api-key") || req.query.key
  if (!incoming || String(incoming) !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" })
  }
  next()
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

function sessionAuthDir(id: string) {
  return path.join(DATA_DIR, "sessions", id)
}

function getOrCreateSession(id: string): SessionData {
  if (sessions.has(id)) return sessions.get(id)!
  const s: SessionData = {
    id,
    authDir: sessionAuthDir(id),
    sock: null,
    status: "closed",
    qr: null,
    chats: new Map(),
    contacts: new Map(),
    messagesByJid: new Map()
  }
  sessions.set(id, s)
  return s
}

async function startSession(id: string, opts?: { usePairingCode?: boolean; phoneNumber?: string | null }) {
  const s = getOrCreateSession(id)
  await ensureDir(s.authDir)

  const { state, saveCreds } = await useMultiFileAuthState(s.authDir)

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Zuria/Render"),
    // Télécharge l’historique après connexion (chats, contacts, messages)
    // Ces données arrivent via l’événement "messaging-history.set"
    // Doc: History Sync (messaging-history.set). :contentReference[oaicite:0]{index=0}
    syncFullHistory: true,
    printQRInTerminal: false,
    markOnlineOnConnect: false
  })

  s.sock = sock
  s.status = "connecting"
  s.qr = null

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      s.qr = qr
    }
    if (connection === "open") {
      logger.info({ id }, "✅ session connected")
      s.status = "connected"
      s.qr = null
    } else if (connection === "close") {
      const code = (lastDisconnect as any)?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      logger.warn({ id, code, shouldReconnect }, "connection closed")
      s.status = "closed"
      s.qr = null
      if (shouldReconnect) {
        // relance douce
        setTimeout(() => startSession(id).catch(() => {}), 3000)
      }
    }
  })

  // Historique initial (chats, contacts, messages)
  sock.ev.on("messaging-history.set", (payload: any) => {
    const { chats = [], contacts = [], messages = [] } = payload || {}
    // chats
    for (const c of chats as any[]) {
      const chat: ChatLite = {
        id: c.id || c.jid || c?.key?.remoteJid || "",
        name: (c as any).name,
        unreadCount: (c as any).unreadCount,
        conversationTimestamp: (c as any).conversationTimestamp
      }
      if (chat.id) s.chats.set(chat.id, chat)
    }
    // contacts
    for (const c of contacts as any[]) {
      const contact: ContactLite = {
        jid: c.id || c.jid,
        name: (c as any).name ?? (c as any).notify,
        verifiedName: (c as any).verifiedName ?? null,
        isBusiness: Boolean((c as any).isBusiness),
        isEnterprise: Boolean((c as any).isEnterprise)
      }
      if (contact.jid) s.contacts.set(contact.jid, contact)
    }
    // messages
    for (const m of messages as any[]) {
      const jid = m?.key?.remoteJid
      if (!jid) continue
      const arr = s.messagesByJid.get(jid) || []
      arr.push({
        key: m.key,
        message: m.message,
        messageTimestamp: Number(m.messageTimestamp || m.message?.messageTimestamp) || undefined,
        pushName: m.pushName,
        fromMe: m.key?.fromMe
      })
      // limite mémoire simple (200 derniers)
      if (arr.length > 200) arr.splice(0, arr.length - 200)
      s.messagesByJid.set(jid, arr)
    }
  })

  // Chats runtime
  sock.ev.on("chats.upsert", (chs: any[]) => {
    for (const c of chs) {
      const chat: ChatLite = {
        id: c.id || c.jid,
        name: c.name,
        unreadCount: c.unreadCount,
        conversationTimestamp: c.conversationTimestamp
      }
      if (chat.id) s.chats.set(chat.id, chat)
    }
  })
  sock.ev.on("chats.update", (chs: any[]) => {
    for (const c of chs) {
      const id = c.id || c.jid
      if (!id) continue
      const prev = s.chats.get(id) || { id }
      s.chats.set(id, { ...prev, ...c })
    }
  })
  sock.ev.on("chats.delete", (ids: string[]) => {
    for (const id of ids) s.chats.delete(id)
  })

  // Contacts runtime
  sock.ev.on("contacts.upsert", (cts: any[]) => {
    for (const c of cts) {
      const contact: ContactLite = {
        jid: c.id || c.jid,
        name: c.name ?? c.notify,
        verifiedName: c.verifiedName ?? null,
        isBusiness: Boolean(c.isBusiness),
        isEnterprise: Boolean(c.isEnterprise)
      }
      if (contact.jid) s.contacts.set(contact.jid, { ...(s.contacts.get(contact.jid) || {}), ...contact })
    }
  })

  // Messages runtime
  sock.ev.on("messages.upsert", (ev: any) => {
    const { messages = [] } = ev || {}
    for (const m of messages) {
      const jid = m?.key?.remoteJid
      if (!jid) continue
      const arr = s.messagesByJid.get(jid) || []
      arr.push({
        key: m.key,
        message: m.message,
        messageTimestamp: Number(m.messageTimestamp || m.message?.messageTimestamp) || undefined,
        pushName: m.pushName,
        fromMe: m.key?.fromMe
      })
      if (arr.length > 200) arr.splice(0, arr.length - 200)
      s.messagesByJid.set(jid, arr)
    }
  })

  // Pairing code (si demandé et non enregistré)
  if (opts?.usePairingCode && opts.phoneNumber && !sock.authState.creds.registered) {
    const code = await sock.requestPairingCode(String(opts.phoneNumber))
    logger.warn({ id, pairingCode: code }, "PAIRING CODE (WhatsApp > Appareils liés > Associer par numéro)")
  }

  return s
}

// ------------------------------------
// Helpers d’accès aux sessions & socket
// ------------------------------------
function mustSession(id: string): SessionData {
  const s = sessions.get(id)
  if (!s) throw new Error("session-not-found")
  if (!s.sock) throw new Error("session-not-ready")
  return s
}

// ---------------
// Serveur Express
// ---------------
const app = express()
app.use(express.json())

app.get("/", (_req, res) => res.send("ok"))
app.get("/health", (_req, res) => res.json({ ok: true }))
app.get("/qr", requireApiKey, async (_req, res) => {
  try {
    const s = getOrCreateSession(DEFAULT_SESSION_ID)
    if (s.status === "closed" || !s.sock) await startSession(DEFAULT_SESSION_ID)
    if (s.status === "connected") return res.json({ error: "already-connected" })
    if (!s.qr) return res.status(404).json({ error: "no-qr-available" })
    return res.json({ sessionId: s.id, qr: s.qr })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "qr-failed" })
  }
})

// -----------------------------
// API multi-sessions (pour Zuria)
// -----------------------------

// Liste des sessions
app.get("/sessions", requireApiKey, (_req, res) => {
  const all = [...sessions.values()].map((s) => ({
    sessionId: s.id,
    status: s.status,
    chatCount: s.chats.size,
    contactCount: s.contacts.size
  }))
  res.json({ sessions: all })
})

// Créer/Init une session
app.post("/sessions/init", requireApiKey, async (req, res) => {
  try {
    const { sessionId, usePairingCode = false, phoneNumber = null } = req.body || {}
    const id = sessionId || crypto.randomUUID()
    const s = await startSession(id, { usePairingCode, phoneNumber })

    // si QR dispo immédiatement
    return res.json({
      success: true,
      sessionId: s.id,
      status: s.status,
      qr: s.qr || null
    })
  } catch (e: any) {
    logger.error(e)
    res.status(500).json({ error: e?.message || "init-failed" })
  }
})

// Statut d’une session
app.get("/sessions/:id", requireApiKey, (req, res) => {
  try {
    const s = mustSession(req.params.id)
    const me = s.sock?.user || s.sock?.user?.id || null
    const phoneNumber =
      (s.sock?.user?.id && String(s.sock.user.id).split(":")[0]) || null
    res.json({
      sessionId: s.id,
      status: s.status,
      isConnected: s.status === "connected",
      me,
      phoneNumber,
      counts: {
        chats: s.chats.size,
        contacts: s.contacts.size
      }
    })
  } catch (e: any) {
    if (e?.message === "session-not-found") return res.status(404).json({ error: "not-found" })
    res.status(500).json({ error: e?.message || "status-failed" })
  }
})

// Obtenir QR d’une session
app.get("/sessions/:id/qr", requireApiKey, (req, res) => {
  try {
    const s = mustSession(req.params.id)
    if (s.status === "connected") return res.status(409).json({ error: "already-connected" })
    if (!s.qr) return res.status(404).json({ error: "no-qr-available" })
    res.json({ sessionId: s.id, qr: s.qr })
  } catch (e: any) {
    if (e?.message === "session-not-found") return res.status(404).json({ error: "not-found" })
    res.status(500).json({ error: e?.message || "qr-failed" })
  }
})

// Déconnexion
app.post("/sessions/:id/logout", requireApiKey, async (req, res) => {
  try {
    const s = mustSession(req.params.id)
    await s.sock?.logout?.()
    s.status = "closed"
    s.qr = null
    res.json({ success: true })
  } catch (e: any) {
    if (e?.message === "session-not-found") return res.status(404).json({ error: "not-found" })
    res.status(500).json({ error: e?.message || "logout-failed" })
  }
})

// Envoi message (POST)
app.post("/sessions/:id/messages/send", requireApiKey, async (req, res) => {
  try {
    const s = mustSession(req.params.id)
    const { to, text } = req.body || {}
    if (!to || !text) return res.status(400).json({ error: "missing to or text" })
    const jid = /@s\.whatsapp\.net$/.test(String(to)) ? String(to) : `${to}@s.whatsapp.net`
    const r = await s.sock.sendMessage(jid, { text })
    res.json({ success: true, response: r })
  } catch (e: any) {
    if (e?.message === "session-not-found") return res.status(404).json({ error: "not-found" })
    res.status(500).json({ error: e?.message || "send-failed" })
  }
})

// Liste des chats (triés par timestamp décroissant)
app.get("/sessions/:id/chats", requireApiKey, (req, res) => {
  try {
    const s = mustSession(req.params.id)
    const limit = Number(req.query.limit || 50)
    const list = [...s.chats.values()]
      .sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0))
      .slice(0, limit)
    res.json({ sessionId: s.id, count: list.length, chats: list })
  } catch (e: any) {
    if (e?.message === "session-not-found") return res.status(404).json({ error: "not-found" })
    res.status(500).json({ error: e?.message || "chats-failed" })
  }
})

// Messages d’un chat (depuis le cache mémoire)
app.get("/sessions/:id/messages", requireApiKey, (req, res) => {
  try {
    const s = mustSession(req.params.id)
    const jid = String(req.query.jid || "")
    const limit = Number(req.query.limit || 50)
    if (!jid) return res.status(400).json({ error: "missing jid" })
    const all = s.messagesByJid.get(jid) || []
    const slice = all.slice(-limit)
    res.json({ sessionId: s.id, jid, count: slice.length, messages: slice })
  } catch (e: any) {
    if (e?.message === "session-not-found") return res.status(404).json({ error: "not-found" })
    res.status(500).json({ error: e?.message || "messages-failed" })
  }
})

// Contacts (depuis le cache)
app.get("/sessions/:id/contacts", requireApiKey, (req, res) => {
  try {
    const s = mustSession(req.params.id)
    const list = [...s.contacts.values()]
    res.json({ sessionId: s.id, count: list.length, contacts: list })
  } catch (e: any) {
    if (e?.message === "session-not-found") return res.status(404).json({ error: "not-found" })
    res.status(500).json({ error: e?.message || "contacts-failed" })
  }
})

// Photo de profil d’un contact (redirect/json/download)
app.get("/sessions/:id/contacts/:jid/photo", requireApiKey, async (req, res) => {
  try {
    const s = mustSession(req.params.id)
    const jid = decodeURIComponent(String(req.params.jid))
    const size = (String(req.query.size || "image") as "image" | "preview")
    const mode = String(req.query.mode || "json") // json | redirect | download

    // Méthode officielle Baileys pour obtenir l’URL de la photo. :contentReference[oaicite:1]{index=1}
    const url = await s.sock.profilePictureUrl(jid, size)

    if (!url) {
      return res.status(404).json({ error: "no-photo" })
    }

    if (mode === "redirect") {
      return res.redirect(url)
    } else if (mode === "download") {
      const r = await fetch(url)
      if (!r.ok || !r.body) return res.status(502).json({ error: "fetch-failed" })
      res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream")
      res.setHeader("Cache-Control", "public, max-age=300")
      r.body.pipeTo((res as any).stream)
      return
    } else {
      return res.json({ sessionId: s.id, jid, url, size })
    }
  } catch (e: any) {
    if (e?.message === "session-not-found") return res.status(404).json({ error: "not-found" })
    res.status(500).json({ error: e?.message || "photo-failed" })
  }
})

// ------------------------
// Compat ancienne /send
// ------------------------
app.post("/send", requireApiKey, async (req, res) => {
  try {
    const s = mustSession(DEFAULT_SESSION_ID)
    const { to, text } = req.body || {}
    if (!to || !text) return res.status(400).json({ error: "Missing to or text" })
    const jid = /@s\.whatsapp\.net$/.test(String(to)) ? String(to) : `${to}@s.whatsapp.net`
    const r = await s.sock.sendMessage(jid, { text })
    res.json({ ok: true, response: r })
  } catch (e: any) {
    if (e?.message === "session-not-found") return res.status(503).json({ error: "WhatsApp socket not ready" })
    res.status(500).json({ error: e?.message || "send failed" })
  }
})

// ------------------------
// Lancement serveur
// ------------------------
app.listen(PORT, async () => {
  logger.info(`HTTP listening on :${PORT}`)
  // démarre la session par défaut pour compat (QR via /qr)
  try {
    await ensureDir(path.join(DATA_DIR, "sessions"))
    await startSession(DEFAULT_SESSION_ID)
  } catch (e) {
    logger.warn({ err: (e as any)?.message }, "default session start failed")
  }
})
