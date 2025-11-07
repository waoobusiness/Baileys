import express from "express";
import pino from "pino";
import path from "node:path";
import fs from "node:fs/promises";
import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  downloadMediaMessage,
  WAMessage
} from "@whiskeysockets/baileys";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/** --------- CONFIG CHEMINS / CLÉ API --------- */
const DATA_DIR = process.env.DATA_DIR || process.env.RENDER_DISK_PATH || "/data";
const AUTH_BASE = process.env.AUTH_DIR || path.join(DATA_DIR, "auth_info_baileys");
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, "media");
const PORT = Number(process.env.PORT || 3001);
const API_KEY = process.env.API_KEY || process.env.GATEWAY_API_KEY || ""; // x-api-key

/** On s’assure que les dossiers existent */
await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
await fs.mkdir(AUTH_BASE, { recursive: true }).catch(() => {});
await fs.mkdir(MEDIA_DIR, { recursive: true }).catch(() => {});
logger.info({ DATA_DIR, AUTH_DIR: AUTH_BASE, MEDIA_DIR }, "paths ready");

/** --------- ÉTAT EN MÉMOIRE --------- */
type Session = {
  id: string;
  sock: any;
  saveCreds: () => Promise<void>;
  lastQR?: string;
  qrAt?: number;
  chats: Map<string, any>;
  contacts: Map<string, any>;
  mediaIndex: Map<string, string>; // msgId -> filepath
};

const sessions = new Map<string, Session>();

/** Auth middleware (sauf /health) */
function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.path === "/health") return next();
  const key = req.get("x-api-key") || String(req.query.key || "");
  if (!API_KEY || key === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
}

/** Création/obtention d’une session */
async function ensureSession(sessionId: string): Promise<Session> {
  const id = sessionId || "default";
  const exists = sessions.get(id);
  if (exists) return exists;

  const authPath = path.join(AUTH_BASE, id);
  await fs.mkdir(authPath, { recursive: true }).catch(() => {});
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // on remonte le QR via l'event
    browser: Browsers.ubuntu("Zuria/Render"),
    markOnlineOnConnect: false,
    syncFullHistory: true
  });

  const s: Session = {
    id,
    sock,
    saveCreds,
    chats: new Map(),
    contacts: new Map(),
    mediaIndex: new Map()
  };
  sessions.set(id, s);

  /** ---------- ÉVÉNEMENTS BAILEYS ---------- */

  sock.ev.on("creds.update", saveCreds);

  // QR
  sock.ev.on("connection.update", (up: any) => {
    const { connection, lastDisconnect, qr } = up || {};
    if (qr) {
      s.lastQR = qr;
      s.qrAt = Date.now();
      logger.info({ sessionId: id, qrAt: s.qrAt }, "QR updated");
    }
    if (connection === "close") {
      const statusCode = (lastDisconnect as any)?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn({ sessionId: id, statusCode }, "WS closed");
      if (shouldReconnect) {
        // redémarrage soft
        setTimeout(async () => {
          try {
            const restarted = await ensureSession(id);
            logger.info({ sessionId: restarted.id }, "session restarted");
          } catch (e) {
            logger.error({ err: e }, "restart failed");
          }
        }, 1500);
      } else {
        sessions.delete(id);
      }
    }
    if (connection === "open") {
      logger.info({ sessionId: id }, "WhatsApp socket OPEN");
    }
  });

  // STORE: chats/contacts
  sock.ev.on("chats.set", ({ chats }: any) => {
    for (const c of chats || []) s.chats.set(String(c.id || c.jid), c);
  });
  sock.ev.on("chats.upsert", (up: any) => {
    for (const c of up || []) s.chats.set(String(c.id || c.jid), c);
  });
  sock.ev.on("chats.update", (up: any) => {
    for (const c of up || []) {
      const id0 = String(c.id || c.jid);
      s.chats.set(id0, { ...(s.chats.get(id0) || {}), ...c });
    }
  });

  sock.ev.on("contacts.set", ({ contacts }: any) => {
    for (const ct of contacts || []) s.contacts.set(String(ct.id || ct.jid), ct);
  });
  sock.ev.on("contacts.upsert", (up: any) => {
    for (const ct of up || []) s.contacts.set(String(ct.id || ct.jid), ct);
  });
  sock.ev.on("contacts.update", (up: any) => {
    for (const ct of up || []) {
      const id0 = String(ct.id || ct.jid);
      s.contacts.set(id0, { ...(s.contacts.get(id0) || {}), ...ct });
    }
  });

  // Messages (save médias)
  sock.ev.on("messages.upsert", async (ev: any) => {
    for (const m of ev.messages as WAMessage[]) {
      const msgId = m.key.id || `${Date.now()}`;
      // si média
      const hasMedia =
        m.message?.imageMessage ||
        m.message?.videoMessage ||
        m.message?.audioMessage ||
        m.message?.documentMessage ||
        m.message?.stickerMessage;

      if (hasMedia) {
        try {
          const stream = await downloadMediaMessage(m, "stream", {}, { logger });
          const fpath = path.join(MEDIA_DIR, `${msgId}`);
          const file = await fs.open(fpath, "w");
          await new Promise<void>((resolve, reject) => {
            stream.on("data", async (chunk) => {
              await file.write(chunk);
            });
            stream.on("end", async () => {
              await file.close();
              resolve();
            });
            stream.on("error", async (e: any) => {
              await file.close().catch(() => {});
              reject(e);
            });
          });
          s.mediaIndex.set(msgId, fpath);
          logger.info({ sessionId: id, msgId, fpath }, "media saved");
        } catch (e) {
          logger.warn({ err: e, sessionId: id }, "media save failed");
        }
      }
    }
  });

  return s;
}

/** --------- APP HTTP --------- */
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(requireApiKey);

app.get("/health", (_req, res) => res.json({ ok: true }));

/** Créer / assurer une session */
app.post("/sessions", async (req, res) => {
  try {
    const sessionId = String((req.body?.sessionId || "default")).trim();
    const s = await ensureSession(sessionId);
    const connected = Boolean(s.sock?.user);
    return res.json({
      ok: true,
      sessionId: s.id,
      status: connected ? "connected" : "connecting",
      isConnected: connected
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "session create failed" });
  }
});

/** Statut session */
app.get("/sessions/:id", async (req, res) => {
  try {
    const s = await ensureSession(String(req.params.id || "default"));
    const connected = Boolean(s.sock?.user);
    return res.json({
      ok: true,
      sessionId: s.id,
      status: connected ? "connected" : "connecting",
      isConnected: connected,
      me: s.sock?.user || null,
      phoneNumber: s.sock?.user?.id || null,
      counts: { chats: s.chats.size, contacts: s.contacts.size },
      qrAvailable: !connected && !!s.lastQR
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "status failed" });
  }
});

/** QR global (session "default") */
app.get("/qr", async (_req, res) => {
  try {
    const s = await ensureSession("default");
    if (!s.lastQR) return res.status(404).json({ error: "no-qr-available" });
    return res.json({ sessionId: s.id, qr: s.lastQR, qrAt: s.qrAt });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "qr failed" });
  }
});

/** QR par session */
app.get("/sessions/:id/qr", async (req, res) => {
  try {
    const s = await ensureSession(String(req.params.id || "default"));
    if (!s.lastQR) return res.status(404).json({ error: "no-qr-available" });
    return res.json({ sessionId: s.id, qr: s.lastQR, qrAt: s.qrAt });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "qr failed" });
  }
});

/** Pairing code par session */
app.post("/sessions/:id/pairing-code", async (req, res) => {
  try {
    const s = await ensureSession(String(req.params.id || "default"));
    if (s.sock?.authState?.creds?.registered) {
      return res.status(400).json({ error: "already-registered" });
    }
    const phoneRaw = String(req.body?.phoneNumber || "").replace(/[^\d]/g, "");
    const custom = String(req.body?.pairing || "").trim(); // optionnel, 8 alphanum
    if (!phoneRaw) return res.status(400).json({ error: "phoneNumber required" });

    const code = custom && /^[A-Za-z0-9]{8}$/.test(custom)
      ? await s.sock.requestPairingCode(phoneRaw, custom)
      : await s.sock.requestPairingCode(phoneRaw);

    return res.json({ sessionId: s.id, pairingCode: code });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "pairing failed" });
  }
});

/** Enregistrer un webhook par session (Lovable/Supabase) */
app.post("/sessions/:id/webhook", async (req, res) => {
  try {
    const s = await ensureSession(String(req.params.id || "default"));
    // Ici, on ne « push » pas les événements ; l’enregistrement est logique côté Supabase.
    // Tu peux stocker ce webhook par session en DB si tu veux, puis appeler depuis messages.upsert etc.
    // Pour l’instant on confirme juste.
    return res.json({ ok: true, sessionId: s.id, note: "Per-session webhook accepted (store on your side)" });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "webhook registration failed" });
  }
});

/** Liste chats (depuis store mémoire) */
app.get("/sessions/:id/chats", async (req, res) => {
  try {
    const s = await ensureSession(String(req.params.id || "default"));
    const list = Array.from(s.chats.entries()).map(([id, c]) => ({
      id,
      name: (c as any)?.name || (c as any)?.subject || null,
      unreadCount: (c as any)?.unreadCount || 0,
      archived: !!(c as any)?.archive
    }));
    return res.json({ sessionId: s.id, count: list.length, chats: list });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "chats failed" });
  }
});

/** Liste contacts (depuis store mémoire) */
app.get("/sessions/:id/contacts", async (req, res) => {
  try {
    const s = await ensureSession(String(req.params.id || "default"));
    const list = Array.from(s.contacts.entries()).map(([jid, ct]) => ({
      jid,
      name: (ct as any)?.name || null,
      verifiedName: (ct as any)?.verifiedName || null,
      isBusiness: !!(ct as any)?.isBusiness,
      isEnterprise: !!(ct as any)?.isEnterprise
    }));
    return res.json({ sessionId: s.id, count: list.length, contacts: list });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "contacts failed" });
  }
});

/** URL photo de profil d’un JID */
app.get("/sessions/:id/profile-picture/:jid", async (req, res) => {
  try {
    const s = await ensureSession(String(req.params.id || "default"));
    const jid = String(req.params.jid);
    const url = await s.sock.profilePictureUrl(jid, "image");
    if (!url) return res.status(404).json({ error: "no-profile-picture" });
    return res.json({ sessionId: s.id, jid, url });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "pp-url failed" });
  }
});

/** Télécharger un média par messageId */
app.get("/media/:messageId", async (req, res) => {
  try {
    const messageId = String(req.params.messageId);
    for (const s of sessions.values()) {
      const p = s.mediaIndex.get(messageId);
      if (p) {
        res.setHeader("Content-Disposition", `inline; filename="${messageId}"`);
        return res.sendFile(p);
      }
    }
    return res.status(404).json({ error: "media-not-found" });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "media failed" });
  }
});

/** Envoi rapide (POST JSON: { to, text }) */
app.post("/sessions/:id/messages/send", async (req, res) => {
  try {
    const s = await ensureSession(String(req.params.id || "default"));
    const to = String(req.body?.to || "").replace(/[^\d]/g, "");
    const text = String(req.body?.text || "");
    if (!to || !text) return res.status(400).json({ error: "to & text required" });
    const jid = `${to}@s.whatsapp.net`;
    const result = await s.sock.sendMessage(jid, { text });
    return res.json({ ok: true, messageId: result?.key?.id || null });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "send failed" });
  }
});

/** Lancement HTTP */
app.listen(PORT, () => logger.info(`HTTP listening on :${PORT}`));
