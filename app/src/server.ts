import express from "express"
import pino from "pino"
import cors from "cors"
import QRCode from "qrcode"
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers
} from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"

const logger = pino({ level: process.env.LOG_LEVEL || "info" })

// --- Config & sécurité ---
const PORT = Number(process.env.PORT || 10000)
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth_info_baileys"
const USE_QR_IN_TERMINAL = String(process.env.PRINT_QR || "false") === "true" // on préfère false (UI web)
const API_KEY = process.env.API_KEY || "" // protège tes endpoints
const ALLOWED_ORIGIN = process.env.ZURIA_ALLOWED_ORIGIN || "*" // ex: https://app.zuria.ai
const ZURIA_WEBHOOK_URL = process.env.ZURIA_WEBHOOK_URL || "" // pour pousser les messages entrants à Zuria.ai

// --- State global ---
let sockGlobal: any = null
let latestQR: string | null = null  // dernier QR reçu (string)

function requireApiKey(req, res, next) {
  if (!API_KEY) return next()
  const headerKey = req.headers["x-api-key"]
  const queryKey = typeof req.query.key === "string" ? req.query.key : undefined
  if (headerKey === API_KEY || queryKey === API_KEY) return next()
  return res.status(401).json({ error: "unauthorized" })
}

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Zuria/Render"),
    printQRInTerminal: USE_QR_IN_TERMINAL,
    markOnlineOnConnect: false
  })

  // Mise à jour de connexion + capture du QR
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQR = qr // on retient le QR pour l’endpoint /qr
      logger.warn("QR updated (available via /qr)")
    }
    if (connection === "close") {
      const status = (lastDisconnect as any)?.error as Boom | undefined
      const code = (status as any)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      logger.warn({ code }, "WS closed, reconnecting?")
      if (shouldReconnect) startWA()
    }
    if (connection === "open") {
      latestQR = null
      logger.info("✅ WhatsApp socket OPEN")
    }
  })

  // Messages entrants
  sock.ev.on("messages.upsert", async (ev) => {
    for (const m of ev.messages) {
      const from = m.key.remoteJid
      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || ""
      logger.info({ from, id: m.key.id, text }, "message received")

      // Pousse à Zuria.ai si configuré (webhook)
      if (ZURIA_WEBHOOK_URL) {
        try {
          await fetch(ZURIA_WEBHOOK_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": API_KEY || "" },
            body: JSON.stringify({ type: "message", from, text, raw: m })
          })
        } catch (e) {
          logger.warn({ err: (e as any)?.message }, "webhook failed")
        }
      }

      // Echo de test (retire-le en prod)
      if (!m.key.fromMe && text) {
        await sock.sendMessage(from!, { text: "Hello from Zuria 🤖" })
      }
    }
  })

  sock.ev.on("creds.update", saveCreds)
  sockGlobal = sock
  return sock
}

async function main() {
  const app = express()
  app.use(express.json())
  app.use(cors({ origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN }))

  // Healthcheck
  app.get("/", (_, res) => res.send("ok"))
  app.get("/health", (_, res) => res.json({ ok: true }))

  // --- Onboarding: QR à afficher dans l'UI ---
  app.get("/qr", requireApiKey, async (_req, res) => {
    if (!latestQR) return res.status(404).json({ error: "no-qr-available" })
    try {
      const png = await QRCode.toBuffer(latestQR, { type: "png", width: 300 })
      res.setHeader("content-type", "image/png")
      return res.send(png)
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "qr-generation-failed" })
    }
  })

  // --- Onboarding: pairing code à la demande ---
  app.get("/pair", requireApiKey, async (req, res) => {
    try {
      const phone = String(req.query.phone || "").trim()
      if (!phone) return res.status(400).json({ error: "missing phone (41XXXXXXXXX)" })
      if (!sockGlobal) return res.status(503).json({ error: "whatsapp socket not ready" })
      const code = await sockGlobal.requestPairingCode(phone)
      logger.warn({ pairingCode: code }, "PAIRING CODE (WhatsApp > Appareils liés > Associer par numéro)")
      return res.json({ pairingCode: code })
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "pairing-failed" })
    }
  })

  // --- Envoi de message (pour tes tests depuis Zuria) ---
  app.post("/send", requireApiKey, async (req, res) => {
    try {
      const to = String(req.body.to || "").trim()
      const text = String(req.body.text || "").trim()
      if (!to || !text) return res.status(400).json({ error: "missing to/text" })
      if (!sockGlobal) return res.status(503).json({ error: "whatsapp socket not ready" })
      await sockGlobal.sendMessage(`${to}@s.whatsapp.net`, { text })
      return res.json({ ok: true })
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "send-failed" })
    }
  })

  app.listen(PORT, () => logger.info(`HTTP listening on :${PORT}`))
  await startWA()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
