// src/server.ts
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
  AnyMessageContent
} from '@whiskeysockets/baileys';

/**
 * =========================
 * Config & helpers
 * =========================
 */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_BASE = process.env.AUTH_BASE || path.resolve(process.cwd(), 'data');
const AUTH_DISABLED = String(process.env.AUTH_DISABLED || '').trim() === '1';

function normToken(s: string) {
  return s.trim().replace(/^['"]|['"]$/g, ''); // retire guillemets collés par erreur
}
function parseTokensFromEnv(): string[] {
  const raw = (process.env.AUTH_TOKENS || process.env.AUTH_TOKEN || '')
    .split(',')
    .map(normToken)
    .filter(Boolean);
  // remove duplicates
  return Array.from(new Set(raw));
}
const TOKENS = parseTokensFromEnv();

const logger = pino({ level: process.env.LOG_LEVEL || 'info', base: undefined });

function tokenMatches(provided: string) {
  const t = normToken(provided);
  return t && TOKENS.includes(t);
}

// Auth middleware – accepte Authorization: Bearer <token> OU X-Api-Key: <token>
function assertAuth(req: express.Request, res: express.Response): boolean {
  if (AUTH_DISABLED) return true; // pour test rapide

  if (!TOKENS.length) {
    logger.warn({ path: req.path }, 'auth required but no tokens configured');
    res.status(403).json({ ok: false, error: 'forbidden' });
    return false;
  }

  const auth = (req.header('authorization') || '').trim();
  const fromBearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const fromApiKey = (req.header('x-api-key') || '').trim();

  const candidate = fromBearer || fromApiKey;
  const ok = tokenMatches(candidate);

  if (!ok) {
    logger.warn({
      path: req.path,
      method: req.method,
      bearerLen: fromBearer.length,
      apiKeyLen: fromApiKey.length,
      tokensConfigured: TOKENS.length
    }, 'auth failed');
    res.status(403).json({ ok: false, error: 'forbidden' });
    return false;
  }
  return true;
}

function parsePhoneFromJid(jid?: string | null): string | null {
  if (!jid) return null;
  const local = jid.split('@')[0].split(':')[0];
  if (!/^\d+$/.test(local)) return null;
  return `+${local}`;
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}
async function rimraf(p: string) {
  if (fssync.existsSync(p)) await fs.rm(p, { recursive: true, force: true });
}

function jidFromPhoneOrJid(input: string): string {
  const s = String(input).trim();
  if (s.includes('@')) return s;
  const digits = s.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

function sseWrite(res: express.Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * =========================
 * Session registry
 * =========================
 */
type SessionStatus = 'pending' | 'qr' | 'connected' | 'disconnected' | 'closed' | 'error' | 'connecting';

type Session = {
  id: string;
  status: SessionStatus;
  sock?: WASocket;
  authDir: string;
  sseClients: Set<express.Response>;
  qrText: string | null;
  qrDataURL: string | null;
  webhookUrl?: string;
  webhookSecret?: string;
  jid?: string | null;
  phone?: string | null;
};

const sessions = new Map<string, Session>();

function getOrCreateSession(sessionId: string): Session {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      id: sessionId,
      status: 'pending',
      authDir: path.join(AUTH_BASE, 'sessions', sessionId),
      sseClients: new Set<express.Response>(),
      qrText: null,
      qrDataURL: null,
      jid: null,
      phone: null
    };
    sessions.set(sessionId, s);
  }
  return s;
}

/**
 * =========================
 * Webhook notifier
 * =========================
 */
async function notifyWebhook(
  s: Session,
  event: string,
  payload: Record<string, unknown>
) {
  try {
    if (!s.webhookUrl) return;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (s.webhookSecret) headers['x-webhook-secret'] = s.webhookSecret;

    const body = {
      event,
      session_id: s.id,
      status: s.status,
      jid: s.jid ?? null,
      phone: s.phone ?? null,
      payload
    };

    await fetch(s.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
  } catch (e) {
    logger.warn({ err: String(e), session: s.id }, 'notifyWebhook failed');
  }
}

/**
 * =========================
 * Baileys wiring
 * =========================
 */
async function startSock(sessionId: string) {
  const s = getOrCreateSession(sessionId);
  s.status = 'connecting';

  await ensureDir(s.authDir);
  const { state, saveCreds } = await useMultiFileAuthState(s.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: ['Zuria.AI', 'Chrome', '121'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000
  });

  s.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      s.qrText = qr;
      try {
        s.qrDataURL = await QRCode.toDataURL(qr);
      } catch {
        s.qrDataURL = null;
      }
      s.status = 'qr';
      for (const res of s.sseClients) sseWrite(res, 'qr', { qrText: s.qrText, qrDataURL: s.qrDataURL });
      await notifyWebhook(s, 'session.status', { status: s.status });
    }

    if (connection === 'open') {
      s.status = 'connected';
      s.jid = sock.user?.id || null;
      s.phone = parsePhoneFromJid(s.jid);
      for (const res of s.sseClients) sseWrite(res, 'connected', { jid: s.jid, phone: s.phone });
      await notifyWebhook(s, 'session.status', { status: s.status, jid: s.jid, phone: s.phone });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        s.status = 'closed';
        for (const res of s.sseClients) sseWrite(res, 'closed', { reason: 'logged_out' });
      } else {
        s.status = 'disconnected';
        for (const res of s.sseClients) sseWrite(res, 'disconnected', { reason: 'connection_closed' });
      }
      await notifyWebhook(s, 'session.status', { status: s.status });
    }
  });

  sock.ev.on('messages.upsert', async (ev) => {
    const msg = ev.messages?.[0];
    if (!msg) return;
    const from = msg.key.remoteJid || '';
    const message: AnyMessageContent | undefined = (msg as any).message;

    const content = {
      text: (message as any)?.conversation || (message as any)?.extendedTextMessage?.text || null,
      audio: !!(message as any)?.audioMessage,
      image: !!(message as any)?.imageMessage,
      video: !!(message as any)?.videoMessage,
      document: !!(message as any)?.documentMessage
    };

    await notifyWebhook(s, 'message.incoming', {
      from,
      message: content,
      raw: undefined
    });
  });

  return sock;
}

async function wipeSession(sessionId: string) {
  const s = getOrCreateSession(sessionId);
  if (s.sock) {
    try { await s.sock.logout(); } catch {}
    try { s.sock.end(undefined); } catch {}
  }
  s.sock = undefined;
  s.status = 'closed';
  s.qrText = null;
  s.qrDataURL = null;
  s.jid = null;
  s.phone = null;
  await rimraf(s.authDir);
}

async function sendText(sessionId: string, to: string, text: string) {
  const s = getOrCreateSession(sessionId);
  if (!s.sock) throw new Error('session_not_started');
  await s.sock.sendMessage(jidFromPhoneOrJid(to), { text });
}

/**
 * =========================
 * HTTP App
 * =========================
 */
const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'zuria-wa-gateway',
    version: '1.0.1',
    auth_required: !AUTH_DISABLED && TOKENS.length > 0,
    tokensConfigured: TOKENS.length,
    sessions: [...sessions.values()].map(s => ({ id: s.id, status: s.status }))
  });
});

// Start (idempotent)
app.post('/sessions/:id/start', async (req, res) => {
  if (!assertAuth(req, res)) return;
  const id = String(req.params.id);
  const { webhookUrl, webhookSecret } = req.body || {};
  try {
    const s = getOrCreateSession(id);
    if (webhookUrl) s.webhookUrl = String(webhookUrl);
    if (webhookSecret) s.webhookSecret = String(webhookSecret);

    if (!s.sock || s.status === 'closed' || s.status === 'error' || s.status === 'disconnected') {
      await startSock(id);
    }
    res.json({ ok: true, id, status: s.status, webhookUrl: s.webhookUrl ?? null });
  } catch (e: any) {
    logger.error({ err: String(e), id }, 'start failed');
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Reset (wipe auth + restart)
app.post('/sessions/:id/reset', async (req, res) => {
  if (!assertAuth(req, res)) return;
  const id = String(req.params.id);
  try {
    await wipeSession(id);
    await startSock(id);
    res.json({ ok: true, id });
  } catch (e: any) {
    logger.error({ err: String(e), id }, 'reset failed');
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Status
app.get('/sessions/:id/status', (req, res) => {
  if (!assertAuth(req, res)) return;
  const id = String(req.params.id);
  const s = getOrCreateSession(id);
  res.json({
    ok: true,
    id,
    status: s.status,
    jid: s.jid ?? null,
    phone: s.phone ?? null
  });
});

// SSE events (qr/connected/status)
app.get('/events/:id', (req, res) => {
  if (!assertAuth(req, res)) return;
  const id = String(req.params.id);
  const s = getOrCreateSession(id);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  sseWrite(res, 'status', { status: s.status, jid: s.jid ?? null, phone: s.phone ?? null });
  if (s.status === 'qr' && s.qrText) {
    sseWrite(res, 'qr', { qrText: s.qrText, qrDataURL: s.qrDataURL });
  }
  if (s.status === 'connected') {
    sseWrite(res, 'connected', { jid: s.jid ?? null, phone: s.phone ?? null });
  }

  s.sseClients.add(res);
  req.on('close', () => s.sseClients.delete(res));
});

// Send text
app.post('/sessions/:id/send-text', async (req, res) => {
  if (!assertAuth(req, res)) return;
  const id = String(req.params.id);
  const { to, text } = req.body || {};
  try {
    if (!to || !text) throw new Error('missing to/text');
    await sendText(id, String(to || ''), String(text || ''));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * =========================
 * Boot
 * =========================
 */
(async () => {
  await ensureDir(path.join(AUTH_BASE, 'sessions'));
  logger.info({
    PORT,
    HOST,
    AUTH_BASE,
    auth_required: !AUTH_DISABLED && TOKENS.length > 0,
    tokensConfigured: TOKENS.length
  }, 'Zuria.AI Baileys Multi-session Gateway up');
  const appInstance = app.listen(PORT, HOST);
  appInstance.setTimeout?.(120000);
})();
