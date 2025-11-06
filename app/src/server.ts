// src/server.ts
import express from "express";
import pino from "pino";
import path from "node:path";
import fs from "node:fs/promises";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} from "@whiskeysockets/baileys";

type SessionState = {
  id: string;
  sock: any;
  saveCreds: () => Promise<void>;
  qr?: string | null;
  qrAt?: number | null;
  status: "connecting" | "connected" | "closed";
  me?: { id?: string; name?: string } | null;
  phoneNumber?: string | null;
  counts: { chats: number; contacts: number; messages: number };
  chats: Map<string, any>;
  contacts: Map<string, any>;
};

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ====== PATHS (toujours sous /data en prod Render) ======
const DATA_DIR = process.env.DATA_DIR || "/data";
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, "auth_info_baileys");
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, "media");

// ====== CONFIG ======
const PORT = Number(process.env.PORT || 3001);
const API_KEY = process.env.API_KEY || ""; // à mettre sur Render
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID || "default";
const PRINT_QR_IN_LOGS = String(process.env.PRINT_QR || "false") === "true";

// ====== STATE ======
const sessions = new Map<string, SessionState>();

// ====== UTILS ======
async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(AUTH_DIR, { recursive: true });
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  logger.info({ DATA_DIR, AUTH_DIR, MEDIA_DIR }, "paths ready");
}

function requireKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  // accepte header x-api-key OU query ?key=
  const key = req.header("x-api-key") || (req.query?.key as string) || "";
  if (!API_KEY) {
    // si pas de clé configurée côté serveur, on bloque pour éviter l'ouverture involontaire
    return res.status(500).json({ error: "server-misconfigured: missing API_KEY" });
  }
  if (key !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function formatJid(phone: string) {
  const trimmed = String(phone).replace(/[^\d]/g, "");
  return trimmed.endsWith("@s.whatsapp.net") ? trimmed : `${trimmed}@s.whatsapp.net`;
}

function sessionInfo(s: SessionState) {
  return {
    sessionId: s.id,
    status: s.status,
    isConnected: s.status === "connected",
    me: s.me || null,
    phoneNumber: s.phoneNumber || (s.me?.id ? String(s.me.id).split(":")[0] : null),
    counts: s.counts,
  };
}

// ====== CORE: start socket ======
async function startSocket(sessionId: string, opts?: { usePairingCode?: boolean; phoneNumber?: string }) {
  const authPath = path.join(AUTH_DIR, sessionId);
  await fs.mkdir(authPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Zuria/Render"),
    printQRInTerminal: PRINT_QR_IN_LOGS,
    markOnlineOnConnect: false,
    syncFullHistory: true,
  });

  // registre en mémoire
  const sess: SessionState = {
    id: sessionId,
    sock,
    saveCreds,
    qr: null,
    qrAt: null,
    status: "connecting",
    me: null,
    phoneNumber: null,
    counts: { chats: 0, contacts: 0, messages: 0 },
    chats: new Map<string, any>(),
    contacts: new Map<string, any>(),
  };
  sessions.set(sessionId, sess);

  // Pairing code (optionnel)
  if (!sock.authState.creds.registered && opts?.usePairingCode && opts?.phoneNumber) {
    try {
      const code = await sock.requestPairingCode(String(opts.phoneNumber));
      logger.warn({ sessionId, pairingCode: code }, "PAIRING CODE");
    } catch (e: any) {
      logger.warn({ sessionId, err: e?.message }, "pairing code request failed");
    }
  }

  // Événements — on "dés-typise" volontairement pour éviter les erreurs TS sur les clés d'events
  (sock.ev as any).on("connection.update", (u: any) => {
    const { connection, lastDisconnect, qr } = u || {};
    if (qr) {
      sess.qr = qr;
      sess.qrAt = Date.now();
      logger.info({ sessionId, qrAt: sess.qrAt }, "QR updated");
    }
    if (connection === "open") {
      sess.status = "connected";
      sess.qr = null;
      sess.qrAt = null;
      logger.info({ sessionId }, "✅ socket OPEN");
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.code ??
        lastDisconnect?.statusCode) as number | undefined;

      const loggedOut = code === DisconnectReason.loggedOut || code === 401;
      sess.status = "closed";

      logger.warn({ sessionId, code, loggedOut }, "socket CLOSED");
      if (!loggedOut) {
        // tentative de reconnexion
        setTimeout(() => startSocket(sessionId).catch(() => {}), 1_000);
      }
    }
  });

  (sock.ev as any).on("creds.update", saveCreds);

  (sock.ev as any).on("chats.set", (ev: any) => {
    // ev.chats: array
    if (Array.isArray(ev?.chats)) {
      for (const c of ev.chats) {
        sess.chats.set(c.id, c);
      }
      sess.counts.chats = sess.chats.size;
    }
  });

  (sock.ev as any).on("contacts.set", (ev: any) => {
    if (Array.isArray(ev?.contacts)) {
      for (const c of ev.contacts) {
        const jid = c.id || c.jid;
        if (jid) sess.contacts.set(jid, c);
      }
      sess.counts.contacts = sess.contacts.size;
    }
  });

  (sock.ev as any).on("messages.upsert", (ev: any) => {
    if (Array.isArray(ev?.messages)) {
      sess.counts.messages += ev.messages.length;
    }
  });

  (sock.ev as any).on("messaging-history.set", (ev: any) => {
    // historisation initiale
    if (Array.isArray(ev?.chats)) {
      for (const c of ev.chats) sess.chats.set(c.id, c);
      sess.counts.chats = sess.chats.size;
    }
    if (Array.isArray(ev?.contacts)) {
      for (const c of ev.contacts) {
        const jid = c.id || c.jid;
        if (jid) sess.contacts.set(jid, c);
      }
      sess.counts.contacts = sess.contacts.size;
    }
  });

  // meta me/user
  try {
    const me = sock.user || (sock as any).user;
    if (me) {
      sess.me = me;
      sess.phoneNumber = me?.id ? String(me.id).split(":")[0] : null;
    }
  } catch {
    // ignore
  }

  return sess;
}

// ====== EXPRESS ======
const app = express();
app.use(express.json({ limit: "2mb" }));

// Public (pas d'API key)
app.get("/health", (_req, res) => res.json({ ok: true }));

// Debug des chemins
app.get("/debug/paths", (_req, res) => {
  res.json({ DATA_DIR, AUTH_DIR, MEDIA_DIR });
});

// ====== DEFAULT session helpers (protégés) ======
app.get("/qr", requireKey, async (_req, res) => {
  const id = DEFAULT_SESSION_ID;
  let s = sessions.get(id);
  if (!s) s = await startSocket(id);

  if (s.status === "connected") {
    return res.json({ sessionId: id, connected: true });
  }
  // si pas de QR en mémoire, on renvoie no-qr
  if (!s.qr) return res.status(404).json({ error: "no-qr-available", sessionId: id });
  return res.json({ sessionId: id, qr: s.qr });
});

app.post("/send", requireKey, async (req, res) => {
  try {
    const id = DEFAULT_SESSION_ID;
    const s = sessions.get(id) || (await startSocket(id));
    if (s.status !== "connected") return res.status(503).json({ error: "session-not-connected" });

    const to = formatJid(String(req.body?.to || ""));
    const text = String(req.body?.text || "");
    if (!to || !text) return res.status(400).json({ error: "missing to/text" });

    const result = await s.sock.sendMessage(to, { text });
    return res.json({ ok: true, id: result?.key?.id || null });
  } catch (e: any) {
    logger.error({ err: e?.message }, "send failed");
    return res.status(500).json({ error: e?.message || "send-failed" });
  }
});

// ====== MULTI-SESSION API (protégée) ======
app.post("/sessions", requireKey, async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId-required" });

    let s = sessions.get(sessionId);
    if (!s) s = await startSocket(sessionId);
    return res.json({ ok: true, ...sessionInfo(s) });
  } catch (e: any) {
    logger.error({ err: e?.message }, "sessions-create-failed");
    return res.status(500).json({ error: e?.message || "create-session-failed" });
  }
});

app.get("/sessions/:id", requireKey, async (req, res) => {
  try {
    const id = String(req.params.id);
    let s = sessions.get(id);
    if (!s) s = await startSocket(id);
    return res.json({ ok: true, ...sessionInfo(s) });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "session-status-failed" });
  }
});

app.get("/sessions/:id/qr", requireKey, async (req, res) => {
  try {
    const id = String(req.params.id);
    let s = sessions.get(id);
    if (!s) s = await startSocket(id);

    if (s.status === "connected") return res.json({ sessionId: id, connected: true });
    if (!s.qr) return res.status(404).json({ error: "no-qr-available", sessionId: id });
    return res.json({ sessionId: id, qr: s.qr });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "qr-failed" });
  }
});

// Pairing code (optionnel si tu veux l’activer)
app.post("/sessions/:id/pairing-code", requireKey, async (req, res) => {
  try {
    const id = String(req.params.id);
    const phoneNumber = String(req.body?.phoneNumber || "").replace(/[^\d]/g, "");
    if (!phoneNumber) return res.status(400).json({ error: "phoneNumber-required" });

    let s = sessions.get(id);
    if (!s) s = await startSocket(id, { usePairingCode: true, phoneNumber });

    // si déjà démarré et pas enregistré, on peut (ré)demander un code
    if (!s.sock.authState.creds.registered) {
      const pairingCode = await s.sock.requestPairingCode(phoneNumber);
      return res.json({ sessionId: id, pairingCode });
    }
    return res.status(400).json({ error: "already-registered-or-not-eligible" });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "pairing-code-failed" });
  }
});

app.post("/sessions/:id/messages/send", requireKey, async (req, res) => {
  try {
    const id = String(req.params.id);
    const to = formatJid(String(req.body?.to || ""));
    const text = String(req.body?.text || "");

    if (!to || !text) return res.status(400).json({ error: "missing to/text" });

    const s = sessions.get(id) || (await startSocket(id));
    if (s.status !== "connected") return res.status(503).json({ error: "session-not-connected" });

    const result = await s.sock.sendMessage(to, { text });
    return res.json({ ok: true, id: result?.key?.id || null });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "send-failed" });
  }
});

app.get("/sessions/:id/chats", requireKey, async (req, res) => {
  try {
    const id = String(req.params.id);
    const s = sessions.get(id) || (await startSocket(id));
    const limit = Number(req.query.limit || 50);

    const items = Array.from(s.chats.values())
      .slice(0, limit)
      .map((c: any) => ({
        id: c.id,
        name: c.name || c.subject || null,
        unreadCount: c.unreadCount ?? 0,
        archived: !!c.archived,
        isGroup: !!c?.id?.endsWith("@g.us"),
      }));

    return res.json({ sessionId: id, count: items.length, chats: items });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "chats-failed" });
  }
});

app.get("/sessions/:id/contacts", requireKey, async (req, res) => {
  try {
    const id = String(req.params.id);
    const s = sessions.get(id) || (await startSocket(id));

    const items = Array.from(s.contacts.entries()).map(([jid, c]: [string, any]) => ({
      jid,
      name: c?.notify || c?.name || null,
      verifiedName: c?.verifiedName ?? null,
      isBusiness: !!c?.isBusiness,
      isEnterprise: !!c?.isEnterprise,
    }));

    return res.json({ sessionId: id, count: items.length, contacts: items });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "contacts-failed" });
  }
});

app.get("/sessions/:id/contacts/photo", requireKey, async (req, res) => {
  try {
    const id = String(req.params.id);
    const jid = String(req.query.jid || "");
    if (!jid) return res.status(400).json({ error: "jid-required" });

    const s = sessions.get(id) || (await startSocket(id));
    const url = await s.sock.profilePictureUrl(jid, "image"); // "preview" ou "image"
    return res.json({ sessionId: id, jid, url: url || null });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "photo-failed" });
  }
});

// ====== BOOT ======
(async () => {
  try {
    await ensureDirs();

    // Démarre une session "default" **optionnelle**.
    // Si tu ne veux pas d'auto-boot, commente la ligne suivante.
    try {
      await startSocket(DEFAULT_SESSION_ID);
    } catch (e: any) {
      logger.warn({ err: e?.message }, "default session start failed");
    }

    app.listen(PORT, () => logger.info(`HTTP listening on :${PORT}`));
  } catch (e: any) {
    logger.error({ err: e?.message }, "fatal boot error");
    process.exit(1);
  }
})();
