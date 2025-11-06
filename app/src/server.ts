import express from "express"
import pino from "pino"
import path from "node:path"
import fs from "node:fs/promises"
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys"

const logger = pino({ level: process.env.LOG_LEVEL || "info" })

// ---------- Config ----------
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth_info_baileys"
const PORT = Number(process.env.PORT || 3001)
const API_KEY = process.env.API_KEY || process.env.WA_API_KEY || "MY_PRIVATE_FURIA_API_KEY_2025"
const PRINT_QR = String(process.env.PRINT_QR || "false") === "true"

// ---------- Types ----------
type ContactLite = {
  jid: string
  name?: string | null
  verifiedName?: string | null
  isBusiness?: boolean
  isEnterprise?: boolean
}

type ChatLite = {
  id: string
  name?: string | null
  unreadCount?: number
}

type Session = {
  id: string
  sock: any
  contacts: Map<string, ContactLite>
  chats: Map<string, ChatLite>
  lastQR?: string | null
  lastQRAt?: number
  webhook?: { url: string; secret: string } | null
}

// ---------- Session Registry ----------
const sessions = new Map<string, Session>()

// Utils
const ensureDir = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true }).catch(() => {})
}

const ok = (res: express.Response, data: any) => res.json(data)
const err = (res: express.Response, code: number, message: string) =>
  res.status(code).json({ error: message })

const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const key = req.header("x-api-key") || String(req.query.key || "")
  if (!key || key !== API_KEY) {
    return err(res, 401, "unauthorized")
  }
  next()
}

// ---------- WA Bootstrap ----------
async function createOrGetSession(sessionId: string) {
  if (sessions.has(sessionId)) return sessions.get(sessionId)!

  const dir = path.join(AUTH_DIR, sessionId)
  await ensureDir(dir)

  const { state, saveCreds } = await useMultiFileAuthState(dir)

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Zuria/Render"),
    printQRInTerminal: PRINT_QR,
    markOnlineOnConnect: false,
  })

  const session: Session = {
    id: sessionId,
    sock,
    contacts: new Map<string, ContactLite>(),
    chats: new Map<string, ChatLite>(),
    lastQR: null,
    lastQRAt: undefined,
    webhook: null,
  }

  // --- Events importants ---
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      session.lastQR = qr
      session.lastQRAt = Date.now()
    }
    if (connection === "close") {
      const statusCode = (lastDisconnect as any)?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      logger.warn({ sessionId, statusCode }, "WS closed")
      if (shouldReconnect) {
        // relance douce : on ne recrée pas une deuxième session dans la map
        setTimeout(() => {
          createOrGetSession(sessionId).catch((e) =>
            logger.error({ e }, "failed to reconnect"),
          )
        }, 2000)
      }
    }
    if (connection === "open") {
      logger.info({ sessionId }, "✅ WhatsApp socket OPEN")
    }
  })

  // Mise à jour des contacts
  sock.ev.on("contacts.upsert", (list: any[]) => {
    for (const c of list) {
      const jid = c?.id || c?.jid
      if (!jid) continue
      session.contacts.set(jid, {
        jid,
        name: c?.name ?? c?.notify ?? null,
        verifiedName: c?.verifiedName ?? null,
        isBusiness: !!c?.isBusiness,
        isEnterprise: !!c?.isEnterprise,
      })
    }
  })

  sock.ev.on("contacts.update", (list: any[]) => {
    for (const u of list) {
      const jid = u?.id || u?.jid
      if (!jid) continue
      const prev = session.contacts.get(jid) || { jid }
      session.contacts.set(jid, {
        ...prev,
        name: u?.name ?? prev.name ?? null,
        verifiedName: u?.verifiedName ?? prev.verifiedName ?? null,
      })
    }
  })

  // Mise à jour des chats (fallback contacts)
  sock.ev.on("chats.upsert", (list: any[]) => {
    for (const ch of list) {
      const id = ch?.id
      if (!id) continue
      session.chats.set(id, {
        id,
        name: ch?.name ?? ch?.subject ?? null,
        unreadCount: ch?.unreadCount ?? 0,
      })
    }
  })

  sock.ev.on("chats.update", (list: any[]) => {
    for (const u of list) {
      const id = u?.id
      if (!id) continue
      const prev = session.chats.get(id) || { id }
      session.chats.set(id, {
        ...prev,
        name: u?.name ?? u?.subject ?? prev.name ?? null,
        unreadCount: u?.unreadCount ?? prev.unreadCount ?? 0,
      })
    }
  })

  sock.ev.on("creds.update", saveCreds)

  sessions.set(sessionId, session)
  return session
}

// ---------- HTTP App ----------
async function main() {
  const app = express()
  app.use(express.json())

  app.get("/", (_req, res) => res.send("ok"))
  app.get("/health", (_req, res) => ok(res, { ok: true }))

  // --- Création simple d’une session (multi-session ready)
  app.post("/sessions/init", auth, async (req, res) => {
    try {
      const { sessionId } = req.body || {}
      if (!sessionId) return err(res, 400, "sessionId required")
      const s = await createOrGetSession(sessionId)
      return ok(res, {
        sessionId,
        status: s.sock?.user ? "connected" : "pending",
      })
    } catch (e: any) {
      logger.error(e)
      return err(res, 500, e?.message || "init failed")
    }
  })

  // --- Statut session
  app.get("/sessions/:id", auth, async (req, res) => {
    try {
      const id = req.params.id
      const s = await createOrGetSession(id)
      const me = s.sock?.user
      return ok(res, {
        sessionId: id,
        status: me ? "connected" : "pending",
        me,
        lastQRAt: s.lastQRAt ?? null,
      })
    } catch (e: any) {
      logger.error(e)
      return err(res, 500, e?.message || "status failed")
    }
  })

  // --- QR en JSON (utile pour tests)
  app.get("/sessions/:id/qr", auth, async (req, res) => {
    const id = req.params.id
    const s = await createOrGetSession(id)
    if (s.sock?.user) return err(res, 409, "already-connected")
    if (!s.lastQR) return err(res, 404, "no-qr-available")
    return ok(res, { sessionId: id, qr: s.lastQR, at: s.lastQRAt })
  })

  // --- SEND minimal (déjà chez toi, conservé)
  app.post("/send", auth, async (req, res) => {
    try {
      const { to, text, sessionId } = req.body || {}
      if (!to || !text) return err(res, 400, "Missing to or text")
      const id = sessionId || "default"
      const s = await createOrGetSession(id)
      if (!s.sock) return err(res, 503, "WhatsApp socket not ready")
      await s.sock.sendMessage(`${to}@s.whatsapp.net`, { text })
      return ok(res, { ok: true })
    } catch (e: any) {
      return err(res, 500, e?.message || "send failed")
    }
  })

  // ============ NOUVEAU: CONTACTS ============
  // Liste des contacts (ou fallback via chats)
  app.get("/sessions/:id/contacts", auth, async (req, res) => {
    try {
      const id = req.params.id
      const s = await createOrGetSession(id)

      // 1) on tente d’utiliser les contacts accumulés par les events
      let contacts = Array.from(s.contacts.values())

      // 2) fallback: si vide, on reconstruit via les chats (persos uniquement)
      if (!contacts.length) {
        const fromChats = Array.from(s.chats.values())
          .filter((c) => c.id.endsWith("@s.whatsapp.net"))
          .map<ContactLite>((c) => ({
            jid: c.id,
            name: c.name ?? null,
            verifiedName: null,
            isBusiness: false,
            isEnterprise: false,
          }))
        contacts = fromChats
      }

      return ok(res, {
        sessionId: id,
        count: contacts.length,
        contacts,
      })
    } catch (e: any) {
      logger.error(e)
      return err(res, 500, e?.message || "contacts failed")
    }
  })

  // Photo d’un contact (URL WhatsApp) — haute résolution si possible
  app.get("/sessions/:id/contacts/:jid/photo", auth, async (req, res) => {
    try {
      const id = req.params.id
      const jid = decodeURIComponent(req.params.jid)
      const full = String(req.query.full || "true") === "true" // 'image' (full) ou défaut

      const s = await createOrGetSession(id)
      // Baileys: profilePictureUrl(jid, 'image') renvoie une URL si dispo
      let url: string | null = null
      try {
        url = await s.sock.profilePictureUrl(jid, full ? "image" : undefined)
      } catch {
        url = null
      }
      return ok(res, { sessionId: id, jid, url })
    } catch (e: any) {
      logger.error(e)
      return err(res, 500, e?.message || "photo failed")
    }
  })
  // ===========================================

  // Pour compat /health simple
  app.get("/health", (_req, res) => ok(res, { ok: true }))

  // Démarrage HTTP
  app.listen(PORT, () => logger.info(`HTTP listening on :${PORT}`))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
