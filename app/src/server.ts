import express from "express";
import cors from "cors";
import pino from "pino";
import { randomUUID, createHmac } from "crypto";
import QRCode from "qrcode";
import makeWASocket from "@whiskeysockets/baileys";
import { Browsers, DisconnectReason, useMultiFileAuthState, jidNormalizedUser } from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const AUTH_BASE_DIR = process.env.AUTH_BASE_DIR || "/data/sessions";
const ALLOWED_ORIGIN = process.env.ZURIA_ALLOWED_ORIGIN || "*";

type MiniChat = { id: string; name?: string; unread?: number };
type MiniStore = { chats: Map<string, MiniChat>; contacts: Map<string, any> };

type Session = {
  id: string;
  authDir: string;
  sock: any | null;
  latestQR: string | null;
  webhookUrl?: string;
  webhookSecret?: string;
  store: MiniStore;
};

const SESSIONS = new Map<string, Session>();

function ensureDir(d: string) {
  fs.mkdirSync(d, { recursive: true });
}

function sign(body: string, secret?: string) {
  if (!secret) return "";
  const h = createHmac("sha256", secret);
  h.update(Buffer.from(body));
  return h.digest("hex");
}

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!API_KEY) return next();
  const headerKey = req.headers["x-api-key"];
  const queryKey = typeof req.query.key === "string" ? req.query.key : undefined;
  if (headerKey === API_KEY || queryKey === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
}

async function emitWebhook(session: Session, event: string, data: any) {
  const url = session.webhookUrl;
  if (!url) return;
  const payload = JSON.stringify({ event, sessionId: session.id, ...data });
  const sig = sign(payload, session.webhookSecret);
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
        "x-api-key": API_KEY
      },
      body: payload
    });
  } catch (e) {
    logger.warn({ session: session.id, e }, "webhook failed");
  }
}

async function startSession(session: Session, opts?: { usePairingCode?: boolean; phoneNumber?: string }) {
  const { id, authDir } = session;
  ensureDir(authDir);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Zuria/Render"),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    logger
  });

  session.sock = sock;
  session.latestQR = null;

  // v7: snapshot initial
  sock.ev.on("messaging-history.set", ({ chats, contacts }) => {
    if (Array.isArray(chats)) {
      for (const c of chats) {
        const jid = (c as any)?.id as string;
        if (!jid) continue;
        session.store.chats.set(jid, {
          id: jid,
          name: (c as any)?.name || (c as any)?.subject || jid,
          unread: 0
        });
      }
    }
    if (Array.isArray(contacts)) {
      for (const ct of contacts) {
        const jid = (ct as any)?.id as string;
        if (!jid) continue;
        session.store.contacts.set(jid, ct);
      }
    }
  });

  // upserts
  sock.ev.on("chats.upsert", (updates: any[]) => {
    for (const c of updates) {
      const jid = c?.id as string;
      if (!jid) continue;
      const existing = session.store.chats.get(jid) || { id: jid };
      session.store.chats.set(jid, {
        ...existing,
        name: c?.name || c?.subject || existing.name || jid
      });
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const m of messages) {
      const from = m.key.remoteJid;
      const text =
        m.message?.conversation ??
        m.message?.extendedTextMessage?.text ??
        m.message?.imageMessage?.caption ??
        "";
      if (from && !m.key.fromMe) {
        const row = session.store.chats.get(from) || { id: from, unread: 0 };
        row.unread = (row.unread || 0) + 1;
        session.store.chats.set(from, row);
      }
      await emitWebhook(session, "message:inbound", { from, text, type, raw: m });
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      session.latestQR = qr;
      logger.warn({ session: id }, "QR refreshed");
    }
    if (connection === "open") {
      session.latestQR = null;
      const me = sock.user;
      const phoneNumber = me?.id ? jidNormalizedUser(me.id).split(":")[0] : null;
      logger.info({ session: id, me }, "session OPEN");
      await emitWebhook(session, "session:connected", { phoneNumber, me });
    }
    if (connection === "close") {
      const code = (lastDisconnect as any)?.error?.output?.statusCode;
      logger.warn({ session: id, code }, "WS closed");
      await emitWebhook(session, "session:disconnected", { code });
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        startSession(session).catch(err => logger.error({ err }, "reconnect failed"));
      }
    }
  });

  if (!sock.authState.creds.registered && opts?.usePairingCode && opts?.phoneNumber) {
    try {
      const code = await sock.requestPairingCode(opts.phoneNumber);
      logger.info({ session: id, code }, "pairing code generated");
      await emitWebhook(session, "session:created", { pairingCode: code });
    } catch (e: any) {
      logger.warn({ session: id, e: e?.message }, "pairing failed to generate");
      await emitWebhook(session, "session:created", {});
    }
  } else {
    await emitWebhook(session, "session:created", {});
  }

  return session;
}

// ----------------- Express -----------------
const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN === "*" ? true : [ALLOWED_ORIGIN] }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, multi: true }));

app.post("/sessions/init", requireApiKey, async (req, res) => {
  try {
    const id = String(req.body?.sessionId || randomUUID());
    if (SESSIONS.has(id)) {
      const s = SESSIONS.get(id)!;
      return res.json({
        sessionId: id,
        status: s.sock?.user ? "connected" : "pending",
        qrAvailable: !!s.latestQR,
        me: s.sock?.user ?? null
      });
    }
    const authDir = path.join(AUTH_BASE_DIR, id, "auth");
    const s: Session = {
      id,
      authDir,
      sock: null,
      latestQR: null,
      store: { chats: new Map(), contacts: new Map() }
    };
    SESSIONS.set(id, s);
    await startSession(s, {
      usePairingCode: !!req.body?.usePairingCode,
      phoneNumber: req.body?.phoneNumber || undefined
    });
    return res.json({
      sessionId: id,
      status: "pending",
      qrAvailable: !!s.latestQR,
      me: s.sock?.user ?? null
    });
  } catch (e: any) {
    logger.error(e);
    return res.status(500).json({ error: e?.message || "init-failed" });
  }
});

app.post("/sessions/:id/restart", requireApiKey, async (req, res) => {
  const id = req.params.id;
  const s = SESSIONS.get(id);
  if (!s) return res.status(404).json({ error: "not-found" });
  try {
    await startSession(s);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "restart-failed" });
  }
});

app.get("/sessions/:id", requireApiKey, (req, res) => {
  const id = req.params.id;
  const s = SESSIONS.get(id);
  if (!s) return res.status(404).json({ error: "not-found" });
  const me = s.sock?.user ?? null;
  const phoneNumber = me?.id ? jidNormalizedUser(me.id).split(":")[0] : null;
  const isConnected = !!me;
  const status = isConnected ? "connected" : "pending";
  return res.json({
    sessionId: id,
    status,
    isConnected,
    phoneNumber,
    me,
    qrAvailable: !!s.latestQR
  });
});

app.get("/sessions/:id/qr", requireApiKey, async (req, res) => {
  const id = req.params.id;
  const s = SESSIONS.get(id);
  if (!s) return res.status(404).json({ error: "not-found" });
  if (!s.latestQR) return res.status(404).json({ error: "no-qr-available" });

  const accept = String(req.headers["accept"] || "");
  const png = await QRCode.toBuffer(s.latestQR, { type: "png", width: 300 });

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (accept.includes("image/png")) {
    res.setHeader("content-type", "image/png");
    return res.send(png);
  } else {
    const b64 = png.toString("base64");
    return res.json({ qr: `data:image/png;base64,${b64}` });
  }
});

app.post("/sessions/:id/pairing-code", requireApiKey, async (req, res) => {
  const id = req.params.id;
  const phone = String(req.body?.phoneNumber || "");
  const s = SESSIONS.get(id);
  if (!s || !s.sock) return res.status(404).json({ error: "not-found" });
  if (!phone) return res.status(400).json({ error: "missing phoneNumber" });
  try {
    const code = await s.sock.requestPairingCode(phone);
    return res.json({ pairingCode: code });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "pairing-failed" });
  }
});

app.post("/sessions/:id/webhook", requireApiKey, async (req, res) => {
  const id = req.params.id;
  const s = SESSIONS.get(id);
  if (!s) return res.status(404).json({ error: "not-found" });
  s.webhookUrl = req.body?.webhookUrl;
  s.webhookSecret = req.body?.secret;
  return res.json({ ok: true });
});

app.post("/sessions/:id/messages/send", requireApiKey, async (req, res) => {
  const id = req.params.id;
  const s = SESSIONS.get(id);
  if (!s?.sock) return res.status(404).json({ error: "not-found" });
  const to = String(req.body?.to || "").trim();
  const text = String(req.body?.text || "").trim();
  if (!to || !text) return res.status(400).json({ error: "missing to/text" });
  try {
    const jid = `${to}@s.whatsapp.net`;
    const resp = await s.sock.sendMessage(jid, { text });
    await emitWebhook(s, "message:outbound", { to, text, resp });
    return res.json({ ok: true, id: resp?.key?.id });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "send-failed" });
  }
});

app.get("/sessions/:id/chats", requireApiKey, (req, res) => {
  const id = req.params.id;
  const s = SESSIONS.get(id);
  if (!s) return res.status(404).json({ error: "not-found" });
  const limit = Number(req.query.limit || 50);
  const out = Array.from(s.store.chats.values()).slice(0, limit);
  return res.json({ chats: out });
});

app.post("/sessions/:id/logout", requireApiKey, async (req, res) => {
  const id = req.params.id;
  const s = SESSIONS.get(id);
  if (!s?.sock) return res.status(404).json({ error: "not-found" });
  try {
    await s.sock.logout();
    s.latestQR = null;
    await emitWebhook(s, "session:disconnected", { code: "logout" });
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "logout-failed" });
  }
});

app.listen(PORT, () => {
  ensureDir(AUTH_BASE_DIR);
  logger.info(`HTTP listening on :${PORT} (multi-session)`);
});
