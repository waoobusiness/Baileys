import express from "express";
import pino from "pino";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  WASocket,
  WAMessage
} from "@whiskeysockets/baileys";
import * as fs from "fs";
import * as path from "path";
import { createHmac } from "crypto";

// ---------- Config & Globals ----------
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const PORT = Number(process.env.PORT || 3001);

// Chemins (avec /data monté en Disk Render)
const DATA_DIR = process.env.DATA_DIR || "/data";
const AUTH_ROOT = process.env.AUTH_DIR || path.join(DATA_DIR, "auth_info_baileys");
const MEDIA_ROOT = process.env.MEDIA_DIR || path.join(DATA_DIR, "media");

// Clé API
const API_KEY = process.env.API_KEY || process.env.FURIA_API_KEY || "change-me";

// Session par défaut
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID || "default";

// Historique complet (Baileys)
const SYNC_FULL_HISTORY = String(process.env.SYNC_FULL_HISTORY || "true") === "true";

// Webhook global (optionnel) si vous n'utilisez pas per-session
const GLOBAL_WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const GLOBAL_WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// Caches & états en mémoire
const sockets = new Map<string, WASocket>();
const lastQRBySession = new Map<string, { qr: string; at: number }>();
const contactsBySession = new Map<string, Map<string, any>>();
const chatsBySession = new Map<string, Map<string, any>>();
const countsBySession = new Map<string, { chats: number; contacts: number }>();
const webhookBySession = new Map<string, { url: string; secret?: string; assistantId?: string }>();

// Utils ensure dirs
for (const d of [DATA_DIR, AUTH_ROOT, MEDIA_ROOT]) {
  fs.mkdirSync(d, { recursive: true });
}
logger.info({ DATA_DIR, AUTH_ROOT, MEDIA_ROOT }, "paths ready");

// ---------- Helpers ----------
function authDirFor(sessionId: string) {
  return path.join(AUTH_ROOT, sessionId);
}
function mediaDirFor(sessionId: string) {
  const p = path.join(MEDIA_ROOT, sessionId);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function ok(res: express.Response, payload: any = {}) {
  return res.json({ ok: true, ...payload });
}
function err(res: express.Response, code: number, message: string, extra: any = {}) {
  return res.status(code).json({ error: message, ...extra });
}
function getApiKey(req: express.Request) {
  return (req.headers["x-api-key"] as string) || (req.query.key as string) || "";
}
function requireKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = getApiKey(req);
  if (!API_KEY || key !== API_KEY) return err(res, 401, "unauthorized");
  next();
}

async function sendWebhook(
  sessionId: string,
  event: string,
  data: any
) {
  const per = webhookBySession.get(sessionId);
  const url = per?.url || GLOBAL_WEBHOOK_URL;
  const secret = per?.secret || GLOBAL_WEBHOOK_SECRET;
  if (!url) return;

  const body = JSON.stringify({ event, sessionId, data, ts: Date.now() });
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (secret) {
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    headers["x-webhook-signature"] = sig;
  }

  try {
    await fetch(url, { method: "POST", headers, body });
  } catch (e) {
    logger.warn({ sessionId, event, err: (e as Error)?.message }, "webhook send failed");
  }
}

function setCounts(sessionId: string) {
  const chats = chatsBySession.get(sessionId)?.size || 0;
  const contacts = contactsBySession.get(sessionId)?.size || 0;
  countsBySession.set(sessionId, { chats, contacts });
}

function sessionStatus(sessionId: string) {
  const sock = sockets.get(sessionId);
  const counts = countsBySession.get(sessionId) || { chats: 0, contacts: 0 };
  // @ts-ignore
  const me = sock?.user || sock?.authState?.creds?.me || undefined;

  return {
    ok: true,
    sessionId,
    status: sock ? (sock?.ws?.readyState ? "connecting" : "connecting") : "pending",
    isConnected: !!me,
    me,
    phoneNumber: me?.id || null,
    counts,
    qrAvailable: lastQRBySession.has(sessionId)
  };
}

// ---------- Socket lifecycle ----------
async function startSocket(sessionId: string) {
  const dir = authDirFor(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS("Desktop"),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    // @ts-ignore (option supportée par la base WhatsApp Web moderne)
    syncFullHistory: SYNC_FULL_HISTORY,
    logger
  });

  sockets.set(sessionId, sock);

  // Persist credentials or session will die
  sock.ev.on("creds.update", saveCreds);

  // Contacts / Chats minimal caches (éviter 'chats.set'/'contacts.set' pour compat TS)
  contactsBySession.set(sessionId, contactsBySession.get(sessionId) || new Map());
  chatsBySession.set(sessionId, chatsBySession.get(sessionId) || new Map());

  sock.ev.on("contacts.upsert", (upd) => {
    const m = contactsBySession.get(sessionId)!;
    for (const c of upd) {
      m.set(c.id, {
        jid: c.id,
        name: (c as any).name ?? (c as any).notify ?? null,
        verifiedName: (c as any).verifiedName ?? null,
        isBusiness: !!(c as any).isBusiness,
        isEnterprise: !!(c as any).isEnterprise
      });
    }
    setCounts(sessionId);
  });

  sock.ev.on("contacts.update", (upd) => {
    const m = contactsBySession.get(sessionId)!;
    for (const c of upd) {
      const prev = m.get(c.id) || { jid: c.id };
      m.set(c.id, {
        ...prev,
        name: (c as any).name ?? prev.name ?? null,
        verifiedName: (c as any).verifiedName ?? prev.verifiedName ?? null
      });
    }
  });

  sock.ev.on("chats.upsert", (ch) => {
    const m = chatsBySession.get(sessionId)!;
    for (const one of ch) {
      m.set(one.id, {
        id: one.id,
        name: (one as any).name ?? null,
        unreadCount: (one as any).unreadCount ?? 0
      });
    }
    setCounts(sessionId);
  });

  sock.ev.on("chats.update", (upd) => {
    const m = chatsBySession.get(sessionId)!;
    for (const u of upd) {
      const prev = m.get(u.id) || { id: u.id };
      m.set(u.id, {
        ...prev,
        name: (u as any).name ?? prev.name ?? null,
        unreadCount: (u as any).unreadCount ?? prev.unreadCount ?? 0
      });
    }
    setCounts(sessionId);
  });

  // Messages -> push webhook
  sock.ev.on("messages.upsert", async (ev) => {
    try {
      const msgs = ev.messages || [];
      for (const m of msgs) {
        await sendWebhook(sessionId, ev.type === "append" ? "message:append" : "message:upsert", sanitizeMsg(m));
      }
    } catch (e) {
      logger.warn({ sessionId, err: (e as Error)?.message }, "messages.upsert webhook failed");
    }
  });

  // Connection/QR
  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      lastQRBySession.set(sessionId, { qr, at: Date.now() });
      logger.info({ sessionId, at: Date.now() }, "QR updated");
      await sendWebhook(sessionId, "session:qr", { qr });
    }

    if (connection === "open") {
      lastQRBySession.delete(sessionId);
      logger.info({ sessionId }, "connected");
      await sendWebhook(sessionId, "session:connected", { me: sock?.user });
    }

    if (connection === "close") {
      const code = (lastDisconnect as any)?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ sessionId, code, shouldReconnect }, "socket closed");
      await sendWebhook(sessionId, "session:disconnected", { code, shouldReconnect });
      sockets.delete(sessionId);
      if (shouldReconnect) {
        setTimeout(() => startSocket(sessionId).catch(() => {}), 1500);
      }
    }
  });

  return sock;
}

function sanitizeMsg(m: WAMessage) {
  try {
    const key = m.key || {};
    const msg = m.message || {};
    const txt =
      (msg.conversation as any) ||
      (msg.extendedTextMessage && (msg.extendedTextMessage as any).text) ||
      null;
    return {
      key: {
        id: key.id,
        fromMe: key.fromMe,
        remoteJid: key.remoteJid
      },
      message: {
        text: txt,
        hasMedia: !!(msg?.imageMessage || msg?.videoMessage || msg?.audioMessage || msg?.documentMessage),
        messageStubType: (m as any).messageStubType
      },
      pushName: (m as any).pushName ?? null,
      ts: (m as any).messageTimestamp || Date.now()
    };
  } catch {
    return { raw: m };
  }
}

// ---------- Express App ----------
const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS léger
app.use((_, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type,x-api-key");
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  next();
});

// Health
app.get("/health", (_req, res) => ok(res, { ok: true }));

// Create/ensure session
app.post("/sessions", requireKey, async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || DEFAULT_SESSION_ID);
    if (!sockets.has(sessionId)) {
      await startSocket(sessionId);
    }
    return ok(res, sessionStatus(sessionId));
  } catch (e: any) {
    logger.warn({ err: e?.message }, "create session failed");
    return err(res, 500, "create-session-failed");
  }
});

// Session state
app.get("/sessions/:id", requireKey, async (req, res) => {
  const sessionId = req.params.id;
  return ok(res, sessionStatus(sessionId));
});

// List sessions (IDs) - basic
app.get("/sessions", requireKey, async (_req, res) => {
  return ok(res, {
    sessions: Array.from(sockets.keys())
  });
});

// Get QR for a session
app.get("/sessions/:id/qr", requireKey, (req, res) => {
  const sessionId = req.params.id;
  const item = lastQRBySession.get(sessionId);
  if (!item) return err(res, 404, "no-qr-available", { sessionId });
  return ok(res, { sessionId, qr: item.qr, qrAt: item.at });
});

// Global QR fallback (supports ?sessionId=)
app.get("/qr", requireKey, (req, res) => {
  const sessionId = String(req.query.sessionId || DEFAULT_SESSION_ID);
  const item = lastQRBySession.get(sessionId);
  if (!item) return err(res, 404, "no-qr-available", { sessionId });
  return ok(res, { sessionId, qr: item.qr, qrAt: item.at });
});

// Pairing code
app.post("/sessions/:id/pairing-code", requireKey, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const phone = String(req.body?.phoneNumber || "").trim(); // E164 sans +
    if (!phone) return err(res, 400, "phoneNumber required");

    if (!sockets.has(sessionId)) {
      await startSocket(sessionId);
    }
    const sock = sockets.get(sessionId)!;

    // @ts-ignore
    const registered = !!sock?.authState?.creds?.registered;
    if (registered) return err(res, 400, "session-already-registered", { sessionId });

    const code = await sock.requestPairingCode(phone);
    return ok(res, { sessionId, pairingCode: code });
  } catch (e: any) {
    logger.warn({ err: e?.message }, "pairing-code failed");
    return err(res, 500, "pairing-code-failed", { detail: e?.message });
  }
});

// Register per-session webhook
app.post("/sessions/:id/webhook", requireKey, async (req, res) => {
  const sessionId = req.params.id;
  const url = String(req.body?.webhookUrl || "").trim();
  const secret = req.body?.secret ? String(req.body.secret) : undefined;
  const assistantId = req.body?.assistantId ? String(req.body.assistantId) : undefined;

  if (!url) return err(res, 400, "webhookUrl required");
  webhookBySession.set(sessionId, { url, secret, assistantId });
  return ok(res, { sessionId, url, hasSecret: !!secret, assistantId });
});

// Logout & clear in-memory sock (conserve fichiers)
app.post("/sessions/:id/logout", requireKey, async (req, res) => {
  const sessionId = req.params.id;
  const sock = sockets.get(sessionId);
  try {
    if (sock) await sock.logout();
  } catch {}
  sockets.delete(sessionId);
  lastQRBySession.delete(sessionId);
  return ok(res, { sessionId, status: "disconnected" });
});

// Simple send text (POST)
app.post("/sessions/:id/messages/send", requireKey, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const to = String(req.body?.to || "").trim();
    const text = String(req.body?.text || "").trim();

    if (!to || !text) return err(res, 400, "to and text required");

    if (!sockets.has(sessionId)) await startSocket(sessionId);
    const sock = sockets.get(sessionId)!;

    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    const sent = await sock.sendMessage(jid, { text });

    await sendWebhook(sessionId, "message:outbound", { to: jid, text });
    return ok(res, { sessionId, to: jid, id: sent?.key?.id });
  } catch (e: any) {
    logger.warn({ err: e?.message }, "send failed");
    return err(res, 500, "send-failed", { detail: e?.message });
  }
});

// Media send (url-based, memory friendly)
app.post("/sessions/:id/messages/send-media", requireKey, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const to = String(req.body?.to || "").trim();
    const type = String(req.body?.type || "image"); // image | video | audio | document
    const url = String(req.body?.url || "").trim();
    const caption = req.body?.caption ? String(req.body.caption) : undefined;

    if (!to || !url) return err(res, 400, "to and url required");

    if (!sockets.has(sessionId)) await startSocket(sessionId);
    const sock = sockets.get(sessionId)!;

    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;

    const content: any = {};
    if (type === "image") content.image = { url };
    else if (type === "video") content.video = { url };
    else if (type === "audio") content.audio = { url, mimetype: "audio/mp4" };
    else if (type === "document") content.document = { url, mimetype: "application/octet-stream" };
    if (caption) content.caption = caption;

    const sent = await sock.sendMessage(jid, content);
    await sendWebhook(sessionId, "message:outbound", { to: jid, type, url, caption });

    return ok(res, { sessionId, to: jid, id: sent?.key?.id });
  } catch (e: any) {
    logger.warn({ err: e?.message }, "send-media failed");
    return err(res, 500, "send-media-failed", { detail: e?.message });
  }
});

// Contacts (cache)
app.get("/sessions/:id/contacts", requireKey, (req, res) => {
  const sessionId = req.params.id;
  const m = contactsBySession.get(sessionId) || new Map();
  return ok(res, {
    sessionId,
    count: m.size,
    contacts: Array.from(m.values())
  });
});

// Chats (cache)
app.get("/sessions/:id/chats", requireKey, (req, res) => {
  const sessionId = req.params.id;
  const m = chatsBySession.get(sessionId) || new Map();
  const limit = Number(req.query.limit || 50);
  const items = Array.from(m.values()).slice(0, limit);
  return ok(res, {
    sessionId,
    count: m.size,
    chats: items
  });
});

// ---------- Boot ----------
app.listen(PORT, async () => {
  logger.info(`HTTP listening on :${PORT}`);

  // Démarrer automatiquement la session par défaut si souhaité
  if (process.env.AUTO_BOOT_DEFAULT === "true") {
    try {
      await startSocket(DEFAULT_SESSION_ID);
    } catch (e: any) {
      logger.warn({ err: e?.message }, "default session start failed");
    }
  }
});
