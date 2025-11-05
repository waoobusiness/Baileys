import express from "express"
import pino from "pino"
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers
} from "@whiskeysockets/baileys"

const logger = pino({ level: process.env.LOG_LEVEL || "info" })
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth_info_baileys"
const PORT = Number(process.env.PORT || 10000)
const USE_QR = String(process.env.PRINT_QR || "false") === "true"
const PHONE = process.env.WHATSAPP_PHONE || "" // ex: 41791234567 (sans +)

let sockGlobal: any = null

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Zuria/Render"),
    printQRInTerminal: USE_QR,
    markOnlineOnConnect: false
  })

  // Première association : code d’appairage (pratique en server headless)
  if (!sock.authState.creds.registered && PHONE) {
    const code = await sock.requestPairingCode(PHONE)
    logger.warn({ pairingCode: code }, "PAIRING CODE (WhatsApp > Appareils liés > Associer par numéro)")
  }

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const statusCode = (lastDisconnect as any)?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      logger.warn({ statusCode }, "WS closed, reconnecting?")
      if (shouldReconnect) startWA()
    }
    if (connection === "open") logger.info("✅ WhatsApp socket OPEN")
  })

  sock.ev.on("messages.upsert", async (ev) => {
    for (const m of ev.messages) {
      logger.info({ from: m.key.remoteJid, id: m.key.id }, "message received")
      if (!m.key.fromMe) {
        await sock.sendMessage(m.key.remoteJid!, { text: "Hello from Zuria 🤖" })
      }
    }
  })

  sock.ev.on("creds.update", saveCreds)
  sockGlobal = sock
  return sock
}

async function main() {
  const app = express()
  app.get("/", (_, res) => res.send("ok"))
  app.get("/health", (_, res) => res.json({ ok: true }))

  // Test rapide: /send?to=4179xxxxxxx&text=hello
  app.get("/send", async (req, res) => {
    try {
      const to = String(req.query.to || "").trim()
      const text = String(req.query.text || "").trim()
      if (!to || !text) return res.status(400).json({ error: "Missing to or text" })
      if (!sockGlobal) return res.status(503).json({ error: "WhatsApp socket not ready" })
      await sockGlobal.sendMessage(`${to}@s.whatsapp.net`, { text })
      return res.json({ ok: true })
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "send failed" })
    }
  })

  app.listen(PORT, () => logger.info(`HTTP listening on :${PORT}`))
  await startWA()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
