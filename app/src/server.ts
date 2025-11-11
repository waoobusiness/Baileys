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

/** ====== STATE ====== */
let sock: WASocket | null = null;
let lastQRDataURL: string | null = null;
let lastQRText: string | null = null;
let lastStatus: 'pending' | 'qr' | 'connected' | 'closed' = 'pending';
let restarting = false;

/** ====== QR LIB (lazy import pour éviter crash si non installée) ====== */
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
    }

    if (connection === 'open') {
      lastStatus = 'connected';
      lastQRDataURL = null;
      lastQRText = null;
      logger.info({ jid: sock?.user?.id }, 'WA connected');
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      lastStatus = 'closed';
      logger.warn({ code, shouldReconnect }, 'WA closed');
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
  } finally {
    restarting = false;
  }
}

/** ====== ROUTES ====== */

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true, status: lastStatus }));

// Session status
app.get('/session/status', (_req, res) => {
  const connected = !!sock?.user;
  res.json({
    ok: true,
    connected,
    jid: sock?.user?.id || null,
    status: connected ? 'connected' : lastStatus,
  });
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
      return res.json({ ok: true, status: 'connected', jid: sock.user.id });
    }

    if (lastStatus === 'qr') {
      const dataURL = lastQRDataURL ?? null;
      const text = lastQRText ?? null;
      // Back-compat (qr/text) + nouveau schéma (qrDataURL/qrText)
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
