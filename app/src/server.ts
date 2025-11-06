import express from "express"
import pino from "pino"
import QRCode from "qrcode"
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys"

type SessionCtx = {
  id: string
  authDir: string
  sock: any | null
  lastQR: string | null
  pairingCode: string | null
  webhook?: { url: string; secret?: string } | null
  contacts: Map<string, any>
  chats: Map<string, any>
}

const logger = pino({ level: process.env.LOG_LEVEL || "info" })

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3001)
// dossier persistant du disque Render (monte ton disk sur /var/data)
const AUTH_BASE_DIR = process.env.AUTH_BASE_DIR || "/var/data/baileys"
// sécurité API
const API_KEY = process.env.API_KEY || "MY_PRIVATE_FURIA_API_KEY_2025"

// session par défaut conservée pour rétro-compat (/qr, /send)
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID || "default"

// ---------- Mémoire des sessions ----------
const sessions = new Map<string, SessionCtx>()

function ensureCtx(sessionId: string): SessionCtx {
  if (!sessions.has(sessionId)) {
    const ctx: SessionCtx = {
      id: sessionId,
      authDir: `${AUTH_BASE_DIR}/sessions/${sessionId}`,
      sock: null,
      lastQR: null,
      pairingCode: null,
      webhook: null,
      contacts: new Map(),
      chats: new Map()
    }
    sessions.set(sessionId, ctx)
  }
  return sessions.get(sessionId)!
}

// ---------- Démarrage d’une socket ----------
async function startSocket(ctx: SessionCtx, opts?: { printQRInTerminal?: boolean }) {
  const { state, saveCreds } = await useMultiFileAuthState(ctx.authDir)

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Zuria/Gateway"),
    markOnlineOnConnect: false,
    printQRInTerminal: Boolean(opts?.printQRInTerminal)
  })

  // met à jour le QR quand dispo
  sock.ev.on("connection.update", (update: any) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      ctx.lastQR = qr
      logger.info({ session: ctx.id }, "QR updated")
    }
    if (connection === "close") {
      const status = (lastDisconnect as any)?.error?.output?.statusCode
      const shouldReconnect = status !== DisconnectReason.loggedOut
      logger.warn({ session: ctx.id, status }, "connection closed")
      if (shouldReconnect) {
        startSocket(ctx).catch((e) => logger.error(e, "reconnect failed"))
      }
    }
    if (connection === "open") {
      ctx.lastQR = null
      logger.info({ session: ctx.id }, "✅ socket OPEN")
    }
  })

  // persiste les creds
  sock.ev.on("creds.update", saveCreds)

  // hydrate mini-store
  sock.ev.on("contacts.upsert", (contacts: any[]) => {
    for (const c of contacts) ctx.contacts.set(c.id || c.jid, c)
  })
  sock.ev.on("contacts.update", (contacts: any[]) => {
    for (const c of contacts) {
      const id = (c as any).id || (c as any).jid
      const prev = ctx.contacts.get(id) || {}
      ctx.contacts.set(id, { ...prev, ...c })
    }
  })
  sock.ev.on("chats.upsert", (chats: any[]) => {
    for (const ch of chats) ctx.chats.set(ch.id, ch)
  })
  sock.ev.on("chats.update", (chats: any[]) => {
    for (const ch of chats) {
      const id = (ch as any).id
      const prev = ctx.chats.get(id) || {}
      ctx.chats.set(id, { ...prev, ...ch })
    }
  })
  sock.ev.on("messages.upsert", async (ev: any) => {
    for (const m of ev.messages || []) {
      logger.info({ session: ctx.id, from: m.key?.remoteJid, id: m.key?.id }, "message")
      // exemple simple d’auto-reply si tu veux
      // if (!m.key.fromMe) await sock.sendMessage(m.key.remoteJid!, { text: "🤖 Zuria est connecté." })
    }
  })

  ctx.sock = sock
  return sock
}

// ---------- Middleware auth ----------
function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.header("x-api-key") || (req.query.key as string)
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" })
  }
  next()
}

// ---------- App ----------
const app = express()
app.use(express.json())

app.get("/", (_, res) => res.send("ok"))
app.get("/health", (_, res) => res.json({ ok: true }))

// -----------------------------
// MULTI-SESSIONS
// -----------------------------

/**
 * Crée (ou redémarre) une session & (optionnel) déclenche le pairing code.
 * body: { sessionId: string, usePairingCode?: boolean, phoneNumber?: string, customPair?: string }
 */
app.post("/sessions/init", auth, async (req, res) => {
  try {
    const { sessionId, usePairingCode, phoneNumber, customPair } = req.body || {}
    if (!sessionId) return res.status(400).json({ error: "sessionId required" })
    const ctx = ensureCtx(sessionId)

    // (re)démarre la socket si absente
    if (!ctx.sock) {
      await startSocket(ctx)
    }

    let pairingCode: string | null = null
    // Si pairing demandé
    if (usePairingCode && phoneNumber && !ctx.sock.authState?.creds?.registered) {
      // API officielle: requestPairingCode(number, customPair?)
      pairingCode = await ctx.sock.requestPairingCode(String(phoneNumber), customPair || undefined)
      ctx.pairingCode = pairingCode
      logger.warn({ session: sessionId, pairingCode }, "PAIRING CODE")
    }

    return res.json({
      sessionId,
      status: ctx.sock?.user ? "connected" : "connecting",
      isConnected: Boolean(ctx.sock?.user),
      pairingCode
    })
  } catch (e: any) {
    logger.error(e, "init failed")
    return res.status(500).json({ error: e?.message || "init failed" })
  }
})

/**
 * Demande/renvoie un pairing code pour une session existante
 * body: { phoneNumber: string, customPair?: string }
 */
app.post("/sessions/:id/pairing-code", auth, async (req, res) => {
  try {
    const sessionId = req.params.id
    const { phoneNumber, customPair } = req.body || {}
    if (!phoneNumber) return res.status(400).json({ error: "phoneNumber required" })

    const ctx = ensureCtx(sessionId)
    if (!ctx.sock) await startSocket(ctx)

    if (ctx.sock.authState?.creds?.registered) {
      return res.status(400).json({ error: "already registered" })
    }

    const code = await ctx.sock.requestPairingCode(String(phoneNumber), customPair || undefined)
    ctx.pairingCode = code
    logger.warn({ session: sessionId, pairingCode: code }, "PAIRING CODE")
    return res.json({ sessionId, pairingCode: code })
  } catch (e: any) {
    logger.error(e, "pairing-code failed")
    return res.status(500).json({ error: e?.message || "pairing failed" })
  }
})

/**
 * Statut session
 */
app.get("/sessions/:id", auth, async (req, res) => {
  try {
    const sessionId = req.params.id
    const ctx = ensureCtx(sessionId)
    if (!ctx.sock) await startSocket(ctx)

    const me = ctx.sock?.user || null
    const phoneNumber = me?.id ? String(me.id).split(":")[0] : null

    return res.json({
      sessionId,
      status: me ? "connected" : "connecting",
      isConnected: Boolean(me),
      me,
      phoneNumber,
      counts: { chats: ctx.chats.size, contacts: ctx.contacts.size },
      qrAvailable: !me && Boolean(ctx.lastQR),
      pairingAvailable: !me && !ctx.lastQR
    })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "status failed" })
  }
})

/**
 * Récupère le QR courant (string + image dataURL)
 */
app.get("/sessions/:id/qr", auth, async (req, res) => {
  try {
    const sessionId = req.params.id
    const ctx = ensureCtx(sessionId)
    if (!ctx.sock) await startSocket(ctx)

    if (!ctx.lastQR) {
      return res.status(404).json({ error: "no-qr-available" })
    }
    const dataUrl = await QRCode.toDataURL(ctx.lastQR)
    return res.json({ sessionId, qr: ctx.lastQR, qrImageDataUrl: dataUrl })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "qr failed" })
  }
})

/**
 * Contacts (liste légère)
 */
app.get("/sessions/:id/contacts", auth, async (req, res) => {
  try {
    const ctx = ensureCtx(req.params.id)
    if (!ctx.sock) await startSocket(ctx)

    const list = Array.from(ctx.contacts.values()).map((c: any) => ({
      jid: c.id || c.jid,
      name: c.name || c.notify || null,
      verifiedName: c.verifiedName || null,
      isBusiness: Boolean(c.isBusiness),
      isEnterprise: Boolean(c.isEnterprise),
      imgUrl: c.imgUrl ?? null
    }))
    return res.json({ sessionId: ctx.id, count: list.length, contacts: list })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "contacts failed" })
  }
})

/**
 * Photo de profil d’un contact
 * /sessions/:id/contacts/photo?jid=xxx@s.whatsapp.net&type=image|preview
 */
app.get("/sessions/:id/contacts/photo", auth, async (req, res) => {
  try {
    const ctx = ensureCtx(req.params.id)
    if (!ctx.sock) await startSocket(ctx)

    const jid = String(req.query.jid || "")
    const type = (String(req.query.type || "preview") as "image" | "preview")
    if (!jid) return res.status(400).json({ error: "jid required" })

    const url = await ctx.sock.profilePictureUrl(jid, type, 10000)
    return res.json({ jid, type, url })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "pp failed" })
  }
})

/**
 * Chats (les derniers)
 */
app.get("/sessions/:id/chats", auth, async (req, res) => {
  try {
    const ctx = ensureCtx(req.params.id)
    if (!ctx.sock) await startSocket(ctx)

    const limit = Math.min(Number(req.query.limit || 50), 200)
    // renvoie ce qu’on a en mémoire (le full history arrivera après la connexion)
    const all = Array.from(ctx.chats.values())
      .slice(0, limit)
      .map((ch: any) => ({
        id: ch.id,
        name: ch.name || ch.subject || ch.displayName || null,
        unreadCount: ch.unreadCount || 0,
        archived: Boolean(ch.archive)
      }))

    return res.json({ sessionId: ctx.id, chats: all })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "chats failed" })
  }
})

/**
 * Envoi texte simple
 * body: { to: "4179...", text: "hello" }
 */
app.post("/sessions/:id/messages/send", auth, async (req, res) => {
  try {
    const ctx = ensureCtx(req.params.id)
    if (!ctx.sock) await startSocket(ctx)

    const to = String(req.body?.to || "").trim()
    const text = String(req.body?.text || "").trim()
    if (!to || !text) return res.status(400).json({ error: "to & text required" })

    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`
    const r = await ctx.sock.sendMessage(jid, { text })
    return res.json({ ok: true, id: r?.key?.id })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "send failed" })
  }
})

/**
 * Logout + cleanup optionnel
 */
app.post("/sessions/:id/logout", auth, async (req, res) => {
  try {
    const ctx = ensureCtx(req.params.id)
    if (!ctx.sock) await startSocket(ctx)
    await ctx.sock.logout()
    ctx.lastQR = null
    ctx.pairingCode = null
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "logout failed" })
  }
})

/**
 * Webhook (enregistrement)
 * body: { url, secret? }
 */
app.post("/sessions/:id/webhook", auth, async (req, res) => {
  const ctx = ensureCtx(req.params.id)
  ctx.webhook = { url: String(req.body?.url || ""), secret: req.body?.secret }
  return res.json({ ok: true })
})

// -----------------------------
// RÉTRO-COMPAT (session "default")
// -----------------------------
app.get("/qr", auth, async (_req, res) => {
  const ctx = ensureCtx(DEFAULT_SESSION_ID)
  if (!ctx.sock) await startSocket(ctx)
  if (!ctx.lastQR) return res.status(404).json({ error: "no-qr-available" })
  return res.json({ sessionId: ctx.id, qr: ctx.lastQR })
})

app.post("/send", auth, async (req, res) => {
  const ctx = ensureCtx(DEFAULT_SESSION_ID)
  if (!ctx.sock) await startSocket(ctx)
  const to = String(req.body?.to || "").trim()
  const text = String(req.body?.text || "").trim()
  if (!to || !text) return res.status(400).json({ error: "to & text required" })
  const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`
  const r = await ctx.sock.sendMessage(jid, { text })
  return res.json({ ok: true, id: r?.key?.id })
})

// -----------------------------
app.listen(PORT, () => {
  logger.info(`HTTP listening on :${PORT}`)
  // démarre la session par défaut pour compat
  const ctx = ensureCtx(DEFAULT_SESSION_ID)
  startSocket(ctx, { printQRInTerminal: false }).catch((e) => {
    logger.warn(e, "default session start failed")
  })
})
