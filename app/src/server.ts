// server.ts
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import fs from 'fs/promises';
import path from 'path';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket
} from '@whiskeysockets/baileys';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cors());

/** ====== ENV ====== */
const PORT = Number(process.env.PORT || 3001);
const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), 'auth');
const GATEWAY_BEARER = process.env.GATEWAY_AUTH_BEARER || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // <- optionnel: Lovable/Supabase webhook pour session.connected

/** ====== STATE ====== */
let sock: WASocket | null = null;
let lastQRDataURL: string | null = null;
let lastQRText: string | null = null;
let lastStatus: 'pending' | 'qr' | 'connected' | 'closed' = 'pending';
let restarting = false;

/** ====== QR LIB (lazy) ====== */
type QRLib = typeof import('qrcode');
let QRCodeLib: QRLib | null = null;
async function ensureQRCodeLib(): Promise<QRLib | null> {
  if (QRCodeLib) return QRCodeLib;
  try {
    QRCodeLib = await import('qrcode');
    return QRCodeLib;
  } catch {
    logger.warn('Package "qrcode" introuvable : fallback texte uniquement (qrText).');
    return null;
  }
}

/** ====== SSE (Server-Sent Events) ====== */
type SSEClient = { res: express.Response; ping: NodeJS.Timeout };
const sseClients = new Set<SSEClient>();

function sseWrite(res: express.Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseBroadcast(event: string, data: unknown) {
  for (const c of sseClients) {
    try { sseWrite(c.res, event, data); } catch {}
  }
}

app.get('/events', (req, res) => {
  // headers SSE
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  // CORS explicite utile pour SSE
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ping keep-alive
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  const client: SSEClient = { res, ping };
  sseClients.add(client);

  // état initial
  const connected = !!sock?.user;
  sseWrite(res, 'status', {
    ok: true,
    status: connected ? 'connected' : lastStatus,
    jid: sock?.user?.id || null
  });
  if (lastStatus === 'qr') {
    sseWrite(res, 'qr', {
      qr: lastQRDataURL ?? null,
      qrDataURL: lastQRDataURL ?? null,
      text: lastQRText ?? null,
      qrText: lastQRText ?? null
    });
  }

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(client);
  });
});

/** ====== UTILS ====== */
function requireBearer(req: express.Request, res: express.Response): boolean {
  const got = (req.headers.authorization || '').trim();
  const ok = got === `Bearer ${GATEWAY_BEARER}` && GATEWAY_BEARER.length > 0;
  if (!ok) res.status(403).json({ ok: false, error: 'forbidden' });
  return ok;
}

async function wipeAuthDir() {
  await fs.rm(AUTH_DIR, { recursive: true, force: true });
  await fs.mkdir(AUTH_DIR, { recursive: true });
  logger.info({ AUTH_DIR }, 'auth dir wiped & recreated');
}

function parsePhoneFromJid(jid?: string | null) {
  if (!jid) return null;
  try { return jid.split('@')[0].split(':')[0] || null; } catch { return null; }
}

async function notifyWebhook(event: string, payload: Record<string, unknown>) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, ...payload })
    });
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'webhook post failed');
  }
}

/** ====== START/RESTART SOCKET ====== */
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  lastQRDataURL = null;
  lastQRText = null;
  lastStatus = 'pending';

  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: ['Zuria.AI Gateway', 'Chrome', '1.0.0'],
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      lastQRText = qr;
      lastStatus = 'qr';
      try {
        const lib = await ensureQRCodeLib();
        if (lib) {
          lastQRDataURL = await lib.toDataURL(qr, { errorCorrectionLevel: 'M' });
          logger.info('QR updated: dataURL ready');
        } else {
          lastQRDataURL = null;
          logger.info('QR updated: text only (no qrcode pkg)');
        }
      } catch (e) {
        lastQRDataURL = null;
        logger.error({ err: e instanceof Error ? e.message : String(e) }, 'QR encode failed');
      }
      // PUSH temps réel au front
      sseBroadcast('qr', {
        qr: lastQRDataURL ?? null,
        qrDataURL: lastQRDataURL ?? null,
        text: lastQRText ?? null,
        qrText: lastQRText ?? null
      });
      sseBroadcast('status', { status: 'qr' });
    }

    if (connection === 'open') {
      lastStatus = 'connected';
      const jid = sock?.user?.id || null;
      const phone = parsePhoneFromJid(jid);
      lastQRDataURL = null;
      lastQRText = null;
      logger.info({ jid }, 'WA connected');

      // PUSH temps réel: front + webhook
      sseBroadcast('connected', { jid, phone });
      sseBroadcast('status', { status: 'connected', jid, phone });
      await notifyWebhook('session.connected', { jid, phone });
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      lastStatus = 'closed';
      logger.warn({ code, shouldReconnect }, 'WA closed');

      sseBroadcast('closed', { code, shouldReconnect });
      sseBroadcast('status', { status: 'closed', code });

      if (shouldReconnect && !restarting) {
        try {
          await startSock();
        } catch (e) {
          logger.error({ err: e instanceof Error ? e.message : String(e) }, 'auto-reconnect failed');
        }
      }
    }
  });

  sock.ev.on('messages.upsert', (m) => {
    const cnt = m.messages?.length || 0;
    logger.debug({ type: m.type, cnt }, 'messages.upsert');
  });

  return sock;
}

async function hardResetAndRestart() {
  if (restarting) return;
  restarting = true;
  try {
    try { await sock?.logout?.(); } catch {}
    try { (sock as any)?.ws?.close?.(); } catch {}
    sock = null;

    await wipeAuthDir();
    await startSock();

    lastStatus = 'pending';
    sseBroadcast('status', { status: 'pending' });
  } finally {
    restarting = false;
  }
}

/** ====== ROUTES ====== */
// Health / root
app.get('/', (_req, res) => res.json({ ok: true, status: 'up', health: ['/health','/healthz'] }));
app.get('/health', (_req, res) => res.json({ ok: true, status: 'up' }));
app.head('/health', (_req, res) => res.status(200).end());
app.get('/healthz', (_req, res) => res.json({ ok: true, status: 'up' }));
app.head('/healthz', (_req, res) => res.status(200).end());

// Session status
app.get('/session/status', (_req, res) => {
  const connected = !!sock?.user;
  const jid = sock?.user?.id || null;
  const phone = parsePhoneFromJid(jid);
  res.json({ ok: true, connected, jid, phone, status: connected ? 'connected' : lastStatus });
});

// Hard reset (secured)
app.post('/session/reset', async (req, res) => {
  if (!requireBearer(req, res)) return;
  try {
    await hardResetAndRestart();
    res.json({ ok: true, status: 'pending' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// Optional: start (soft init)
app.post('/session/start', async (_req, res) => {
  try {
    if (!sock) await startSock();
    res.json({ ok: true, status: lastStatus });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// QR endpoint (JSON). If connected + force=1 and auth ok -> hard reset first.
app.get('/qr', async (req, res) => {
  try {
    const force = String(req.query.force || '') === '1';

    if (sock?.user && force) {
      if (!requireBearer(req, res)) return;
      await hardResetAndRestart();
    }

    if (sock?.user) {
      const jid = sock.user.id;
      const phone = parsePhoneFromJid(jid);
      return res.json({ ok: true, status: 'connected', jid, phone });
    }

    if (lastStatus === 'qr') {
      const dataURL = lastQRDataURL ?? null;
      const text = lastQRText ?? null;
      return res.json({
        ok: true,
        status: 'qr',
        qr: dataURL,
        text,
        qrDataURL: dataURL,
        qrText: text
      });
    }

    return res.json({ ok: true, status: lastStatus }); // 'pending' | 'closed'
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** ====== SEND HELPERS ====== */
app.post('/send-text', async (req, res) => {
  try {
    const { to, text } = req.body as { to: string; text: string };
    if (!sock) return res.status(503).json({ ok: false, error: 'not_ready' });
    await sock.sendMessage(
      to.endsWith('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`,
      { text }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** ====== BOOT ====== */
(async () => {
  await fs.mkdir(AUTH_DIR, { recursive: true });
  await startSock();
  app.listen(PORT, () => {
    logger.info({ PORT, AUTH_DIR }, 'Zuria.AI Baileys Gateway up');
  });
})();
