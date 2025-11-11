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

type SessionStatus = 'pending' | 'qr' | 'connecting' | 'connected' | 'closed' | 'error';

type Session = {
  id: string;
  sock?: WASocket;
  status: SessionStatus;
  qrText?: string | null;
  qrDataURL?: string | null;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  jid?: string | null;
  phone?: string | null;
  sseClients: Set<express.Response>;
};

const PORT = Number(process.env.PORT || 3000);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''; // bearer pour sécuriser l’API
const AUTO_DOWNLOAD_MEDIA = process.env.AUTO_DOWNLOAD_MEDIA === '1';
const ECHO_REPLY = process.env.ECHO_REPLY === '1';

const AUTH_BASE =
  process.env.AUTH_DIR ||
  process.env.DATA_DIR ||
  path.resolve(process.cwd(), 'auth');

const logger = pino({ level: LOG_LEVEL });
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

/** ========= Utilities ========= */

function assertAuth(req: express.Request, res: express.Response): boolean {
  if (!AUTH_TOKEN) return true;
  const hdr = req.headers['authorization'] || '';
  const token = Array.isArray(hdr) ? hdr[0] : hdr;
  if (!token?.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'missing bearer' });
    return false;
  }
  if (token.slice(7) !== AUTH_TOKEN) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return false;
  }
  return true;
}

function parsePhoneFromJid(jid?: string | null): string | null {
  if (!jid) return null;
  const m = jid.match(/^(\d+)\D/);
  return m ? `+${m[1]}` : null;
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

function sseWrite(res: express.Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** ========= Sessions registry ========= */

const sessions = new Map<string, Session>();

function getOrCreateSession(sessionId: string): Session {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      id: sessionId,
      status: 'pending',
      sseClients: new Set(),
      qrText: null,
      qrDataURL: null,
      webhookUrl: null,
      webhookSecret: null,
      jid: null,
      phone: null
    };
    sessions.set(sessionId, s);
  }
  return s;
}

async function notifyWebhook(s: Session, event: string, payload: any) {
  if (!s.webhookUrl) return;
  try {
    await fetch(s.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(s.webhookSecret ? { 'x-webhook-secret': s.webhookSecret } : {})
      },
      body: JSON.stringify({ event, session_id: s.id, ...payload })
    });
  } catch (e) {
    logger.warn({ err: String(e), session: s.id }, 'notifyWebhook failed');
  }
}

async function startSock(sessionId: string) {
  const s = getOrCreateSession(sessionId);
  s.status = 'connecting';

  const dir = path.join(AUTH_BASE, 'sessions', sessionId);
  await ensureDir(dir);

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: ['Zuria.AI Gateway', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
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
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      s.status = 'closed';
      for (const res of s.sseClients) sseWrite(res, 'closed', { code: statusCode, shouldReconnect });
      await notifyWebhook(s, 'session.status', { status: s.status, code: statusCode, shouldReconnect });

      if (shouldReconnect) {
        setTimeout(() => startSock(sessionId).catch(e => logger.error(e)), 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const messages = m.messages ?? [];
    for (const msg of messages) {
      const text =
        (msg.message as any)?.conversation ||
        (msg.message as any)?.extendedTextMessage?.text ||
        (msg.message as any)?.imageMessage?.caption ||
        '';

      // Diffuse à l’UI (SSE session)
      for (const res of s.sseClients) sseWrite(res, 'message', { direction: 'in', text, key: msg.key });

      // Envoi au webhook Lovable
      await notifyWebhook(s, 'message.incoming', {
        jid: s.jid,
        phone: s.phone,
        type: 'text',
        message: { text, key: msg.key, raw: msg }
      });

      if (ECHO_REPLY && text) {
        await sendText(sessionId, s.phone || '', text).catch(() => {});
      }
    }
  });

  // ping initial
  await notifyWebhook(s, 'session.status', { status: 'connecting' });
}

async function wipeSession(sessionId: string) {
  const s = getOrCreateSession(sessionId);
  try { await s.sock?.logout(); } catch {}
  try { s.sock?.end?.(); } catch {}
  s.sock = undefined;
  s.status = 'pending';
  s.qrText = null; s.qrDataURL = null; s.jid = null; s.phone = null;

  const dir = path.join(AUTH_BASE, 'sessions', sessionId);
  if (fssync.existsSync(dir)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function sendText(sessionId: string, to: string, text: string) {
  const s = getOrCreateSession(sessionId);
  if (!s.sock) throw new Error('session not started');
  if (!to) throw new Error('missing destination phone');
  const jid = to.replace(/[^\d]/g, '') + '@s.whatsapp.net';
  await s.sock.sendMessage(jid, { text } as AnyMessageContent);
  for (const res of s.sseClients) sseWrite(res, 'message', { direction: 'out', to, text });
  await notifyWebhook(s, 'message.outgoing', { to, text });
}

/** ========= HTTP routes ========= */

app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// List sessions
app.get('/sessions', (req, res) => {
  if (!assertAuth(req, res)) return;
  const all = Array.from(sessions.values()).map(s => ({
    id: s.id, status: s.status, phone: s.phone, jid: s.jid, webhookUrl: s.webhookUrl
  }));
  res.json({ ok: true, sessions: all });
});

// Start session (or update webhook)
app.post('/sessions/:id/start', async (req, res) => {
  if (!assertAuth(req, res)) return;
  const id = req.params.id;
  const { webhookUrl, webhookSecret } = req.body || {};
  try {
    const s = getOrCreateSession(id);
    if (webhookUrl) s.webhookUrl = webhookUrl;
    if (webhookSecret) s.webhookSecret = webhookSecret;
    if (!s.sock || s.status === 'closed' || s.status === 'pending' || s.status === 'error') {
      await startSock(id);
    }
    res.json({ ok: true, id, status: s.status, webhookUrl: s.webhookUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// Reset (wipe auth + restart)
app.post('/sessions/:id/reset', async (req, res) => {
  if (!assertAuth(req, res)) return;
  const id = req.params.id;
  try {
    await wipeSession(id);
    await startSock(id);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// Status
app.get('/sessions/:id/status', (req, res) => {
  if (!assertAuth(req, res)) return;
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'unknown session' });
  res.json({
    ok: true,
    id, status: s.status, phone: s.phone, jid: s.jid,
    hasWebhook: !!s.webhookUrl
  });
});

// QR (debug view)
app.get('/sessions/:id/qr', async (req, res) => {
  if (!assertAuth(req, res)) return;
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'unknown session' });
  res.json({ ok: true, id, status: s.status, qrText: s.qrText, qrDataURL: s.qrDataURL });
});

// SSE per-session
app.get('/events/:id', (req, res) => {
  if (!assertAuth(req, res)) return;
  const id = req.params.id;
  const s = getOrCreateSession(id);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  s.sseClients.add(res);
  // snapshot
  sseWrite(res, 'status', { status: s.status, phone: s.phone, jid: s.jid });
  if (s.status === 'qr' && s.qrDataURL) {
    sseWrite(res, 'qr', { qrText: s.qrText, qrDataURL: s.qrDataURL });
  }

  const keepAlive = setInterval(() => sseWrite(res, 'ping', { ts: Date.now() }), 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    s.sseClients.delete(res);
  });
});

// Send text via a session
app.post('/sessions/:id/send-text', async (req, res) => {
  if (!assertAuth(req, res)) return;
  const id = req.params.id;
  const { to, text } = req.body || {};
  try {
    await sendText(id, String(to || ''), String(text || ''));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** ====== Boot ====== */
(async () => {
  await ensureDir(path.join(AUTH_BASE, 'sessions'));
  app.listen(PORT, () => {
    logger.info({ PORT, AUTH_BASE }, 'Zuria.AI Baileys Multi-session Gateway up');
  });
})();
