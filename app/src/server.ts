import express from "express";
import pino from "pino";
import path from "node:path";
import fs from "node:fs/promises";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

type SessionState = {
  id: string;
  authDir: string;
  mediaDir: string;
  sock?: any;
  saveCreds?: () => Promise<void>;
  lastQR?: { qr: string; at: number };
  webhook?: { url: string; secret?: string } | null;
  cache: {
    chats: Array<{ id: string; name?: string; unreadCount?: number }>;
    contacts: Array<{
      jid: string;
      name?: string;
      verifiedName?: string | null;
      isBusiness?: boolean;
      isEnterprise?: boolean;
    }>;
  };
};

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const PORT = Number(process.env.PORT || 3001);
const API_KEY = process.env.API_KEY || process.env.FURIA_API_KEY || "changeme";
const DATA_DIR = process.env.DATA_DIR || "/data";
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID || "default";

function requireKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const k = req.get("x-api-key") || (req.query.key as string) || "";
  if (!k || k !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, "auth"), { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, "media"), { recursive: true });
  logger.info(
    { DATA_DIR, AUTH_DIR: path.join(DATA_DIR, "auth"), MEDIA_DIR: path.join(DATA_DIR, "media") },
    "paths ready"
  );
}

const sessions = new Map<string, SessionState>();

function getSession(id: string) {
  return sessions.get(id);
}

async function createSessionState(id: string): Promise<SessionState> {
  const state: SessionState = {
    id,
    authDir: path.join(DATA_DIR, "auth", id),
    mediaDir: path.join(DATA_DIR, "media", id),
    webhook: null,
    cache: { chats: [], contacts: [] }
  };
  await fs.mkdir(state.authDir, { recursive: true });
  await fs.mkdir(state.mediaDir, { recursive: true });
  sessions.set(id, state);
  return state;
}

async function startSocket(
  sessionId: string,
  opts?: { force?: boolean; pairing?: { phone: string } }
) {
  let state = getSession(sessionId) || (await createSessionState(sessionId));
  if (state.sock && !opts?.force) {
    return state;
  }

  const { state: authState, saveCreds } = await useMultiFileAuthState(state.authDir);

  const sock = makeWASocket({
    auth: authState,
    printQRInTerminal: false,            // on gère le QR via event
    browser: Browsers.macOS("Desktop"),  // 1 seul argument (plein historique)
    markOnlineOnConnect: false,
    syncFullHistory: true                // récupère un historique plus complet
  });

  state.sock = sock;
  state.saveCreds = saveCreds;

  // Connexion & QR
  sock.ev.on("connection.update", (update: any) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      state.lastQR = { qr, at: Date.now() };
      logger.info({ sessionId, qrAt: state.lastQR.at }, "QR updated");
    }

    if (connection === "open") {
      logger.info({ sessionId }, "WA socket OPEN");
    } else if (connection === "close") {
      const code = (lastDisconnect as any)?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ sessionId, code }, "socket closed");
      if (shouldReconnect) {
        setTimeout(() => startSocket(sessionId, { force: true }).catch(() => {}), 1500);
      } else {
        state.lastQR = undefined;
      }
    }
  });

  // Sauvegarde des creds (critique)
  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
    } catch (e) {
      logger.warn({ sessionId, err: (e as Error).message }, "saveCreds failed");
    }
  });

  // Historique (chats/contacts) — on cast en any pour ignorer les types stricts d’EventMap
  (sock.ev as any).on("chats.set", (ev: any) => {
    try {
      const arr = Array.isArray(ev) ? ev : ev?.chats || [];
      state.cache.chats = arr
        .map((c: any) => ({ id: c?.id, name: c?.name, unreadCount: c?.unreadCount }))
        .filter((c: any) => c?.id);
    } catch {}
  });

  (sock.ev as any).on("contacts.set", (ev: any) => {
    try {
      const arr = Array.isArray(ev) ? ev : ev?.contacts || [];
      state.cache.contacts = arr
        .map((ct: any) => ({
          jid: ct?.id || ct?.jid,
          name: ct?.name,
          verifiedName: ct?.verifiedName ?? null,
          isBusiness: Boolean(ct?.isBusiness),
          isEnterprise: Boolean(ct?.isEnterprise)
        }))
        .filter((ct: any) => ct?.jid);
    } catch {}
  });

  // Pairing code si demandé et non enregistré
  if (!sock.authState.creds.registered && opts?.pairing?.phone) {
    try {
      // ATTENTION: API officielle prend 1 seul argument (le numéro E.164 SANS '+')
      const pairingCode: string = await sock.requestPairingCode(opts.pairing.phone);
      logger.info({ sessionId, pairingCode }, "pairing code generated");
    } catch (e) {
      logger.warn({ sessionId, err: (e as Error).message }, "pairing code request failed");
    }
  }

  return state;
}

function sessionStatusPayload(s: SessionState) {
  const sock = s.sock;
  const isConnected = Boolean(sock?.user);
  const me = sock?.user || null;
  const phoneNumber = me?.id || null;
  return {
    ok: true,
    sessionId: s.id,
    status: isConnected ? "connected" : "connecting",
    isConnected,
    me,
    phoneNumber,
    counts: { chats: s.cache.chats.length, contacts: s.cache.contacts.length },
    qrAvailable: Boolean(s.lastQR?.qr)
  };
}

// ------------------- HTTP -------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_, res) => res.json({ ok: true }));

// Auth middleware (sauf /health)
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  return requireKey(req, res, next);
});

// Créer/assurer une session
app.post("/sessions", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || DEFAULT_SESSION_ID);
    const pairingPhone = (req.body?.pairingPhone as string | undefined)?.replace(/[^\d]/g, "");

    const s = await startSocket(sessionId, pairingPhone ? { pairing: { phone: pairingPhone } } : undefined);
    return res.json(sessionStatusPayload(s));
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "create session failed" });
  }
});

// Statut session
app.get("/sessions/:id", async (req, res) => {
  const id = String(req.params.id);
  const s = getSession(id) || (await startSocket(id));
  return res.json(sessionStatusPayload(s));
});

// QR pour une session
app.get("/sessions/:id/qr", async (req, res) => {
  const id = String(req.params.id);
  const s = getSession(id) || (await startSocket(id));
  if (s.lastQR?.qr) return res.json({ sessionId: id, qr: s.lastQR.qr, qrAt: s.lastQR.at });
  return res.status(404).json({ error: "no-qr-available" });
});

// Pairing code (1 seul argument pris en charge par la lib officielle)
app.post("/sessions/:id/pairing-code", async (req, res) => {
  try {
    const id = String(req.params.id);
    const phone = String(req.body?.phoneNumber || "").replace(/[^\d]/g, "");
    if (!phone) return res.status(400).json({ error: "phoneNumber required (E.164 without +)" });

    const s = getSession(id) || (await startSocket(id));
    if (!s.sock) return res.status(503).json({ error: "socket not ready" });
    if (s.sock.authState.creds.registered) return res.status(409).json({ error: "already-registered" });

    const code: string = await s.sock.requestPairingCode(phone);
    return res.json({ sessionId: id, pairingCode: code });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "pairing-code failed" });
  }
});

// Déconnexion
app.post("/sessions/:id/logout", async (req, res) => {
  const id = String(req.params.id);
  const s = getSession(id);
  if (!s?.sock) return res.status(404).json({ error: "unknown session" });
  try {
    await s.sock.logout();
    s.lastQR = undefined;
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "logout failed" });
  }
});

// Webhook par session (enregistrement, persistant côté gateway)
app.post("/sessions/:id/webhook", async (req, res) => {
  const id = String(req.params.id);
  const { webhookUrl, secret } = req.body || {};
  if (!webhookUrl) return res.status(400).json({ error: "webhookUrl required" });
  const s = getSession(id) || (await startSocket(id));
  s.webhook = { url: String(webhookUrl), secret: secret ? String(secret) : undefined };
  return res.json({ ok: true });
});

// Contacts (snapshot)
app.get("/sessions/:id/contacts", async (req, res) => {
  const id = String(req.params.id);
  const s = getSession(id) || (await startSocket(id));
  return res.json({ sessionId: id, count: s.cache.contacts.length, contacts: s.cache.contacts });
});

// Chats (snapshot)
app.get("/sessions/:id/chats", async (req, res) => {
  const id = String(req.params.id);
  const s = getSession(id) || (await startSocket(id));
  return res.json({ sessionId: id, count: s.cache.chats.length, chats: s.cache.chats });
});

// Raccourci : QR de la session par défaut
app.get("/qr", async (req, res) => {
  const s = getSession(DEFAULT_SESSION_ID) || (await startSocket(DEFAULT_SESSION_ID));
  if (s.lastQR?.qr) return res.json({ sessionId: s.id, qr: s.lastQR.qr, qrAt: s.lastQR.at });
  return res.status(404).json({ error: "no-qr-available" });
});

// Boot
(async () => {
  await ensureDirs();
  await startSocket(DEFAULT_SESSION_ID).catch((err) => {
    logger.warn({ err }, "default session start failed");
  });

  app.listen(PORT, () => logger.info(`HTTP listening on :${PORT}`));
})();
