import express from 'express';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode';
import mime from 'mime-types';
import * as crypto from 'crypto';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  WAMessage,
  proto,
  WAMessageKey
} from '@whiskeysockets/baileys';
import { EventEmitter } from 'events';

// ---------- ENV & paths ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data-auth');
const AUTO_DOWNLOAD_MEDIA = process.env.AUTO_DOWNLOAD_MEDIA === '1';
const ECHO_REPLY = process.env.ECHO_REPLY === '1';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const WEBHOOK_OUTBOX_URL = process.env.WEBHOOK_OUTBOX_URL || '';
const WEBHOOK_SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET || '';

// ---------- Logger ----------
const logger = pino({ level: LOG_LEVEL });

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '20mb' }));

// ---------- Storage (filesystem) ----------
const STORE_DIR = path.join(DATA_DIR, 'store');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const MSG_DIR = path.join(STORE_DIR, 'messages');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(STORE_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(MSG_DIR, { recursive: true });

const contactsPath = path.join(STORE_DIR, 'contacts.json');
const chatsPath = path.join(STORE_DIR, 'chats.json');

type Contact = {
  jid: string;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
  isBusiness?: boolean;
};
type Chat = {
  jid: string;
  name?: string | null;
  unreadCount?: number;
  lastMsgTs?: number;
};
type StoredMessage = {
  key?: proto.IMessageKey | null;
  pushName?: string | null;
  timestamp?: number;
  type?: string | null;
  text?: string | null;
  reactions?: Array<{ from: string; emoji: string; ts: number }>;
  media?: { file: string; mimetype: string; bytes: number } | { error: string };
  raw?: WAMessage;
};

function readJSON<T>(p: string, def: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return def; }
}
function writeJSON(p: string, obj: unknown) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function msgFile(jid: string) { return path.join(MSG_DIR, encodeURIComponent(jid) + '.ndjson'); }
function appendMessage(jid: string, obj: StoredMessage) {
  fs.appendFileSync(msgFile(jid), JSON.stringify(obj) + '\n');
}
function readMessages(jid: string, limit = 50, beforeTs?: number | null): StoredMessage[] {
  const file = msgFile(jid);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  let arr = lines.map((l) => { try { return JSON.parse(l) as StoredMessage; } catch { return null as any; } })
                 .filter(Boolean);
  if (beforeTs) arr = arr.filter((m) => (m.timestamp || 0) < beforeTs);
  return arr.slice(-limit);
}
function findMessage(jid: string, id: string): StoredMessage | null {
  const file = msgFile(jid);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = JSON.parse(lines[i]) as StoredMessage;
    if ((m.key as any)?.id === id) return m;
  }
  return null;
}

let contacts: Record<string, Contact> = readJSON(contactsPath, {});
let chats: Record<string, Chat> = readJSON(chatsPath, {});
function saveContacts() { writeJSON(contactsPath, contacts); }
function saveChats() { writeJSON(chatsPath, chats); }

// ---------- WA socket state ----------
let sock: ReturnType<typeof makeWASocket> | null = null;
let lastQR: string | null = null;
let connInfo: { status: string; reason?: string } = { status: 'starting' };

// ---------- Events bus + webhooks ----------
const bus = new EventEmitter();

function postWebhook(evt: any) {
  if (!WEBHOOK_OUTBOX_URL) return;
  const json = JSON.stringify(evt);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (WEBHOOK_SIGNING_SECRET) {
    const sig = crypto.createHmac('sha256', WEBHOOK_SIGNING_SECRET).update(json).digest('hex');
    headers['x-signature'] = sig;
  }
  // fire-and-forget
  fetch(WEBHOOK_OUTBOX_URL, { method: 'POST', headers, body: json }).catch(() => {});
}

function emitEvent(type: string, payload: any) {
  const evt = { type, payload, t: Date.now() };
  bus.emit('evt', evt);
  postWebhook(evt);
}

// ---------- Helpers ----------
function extractText(msg?: WAMessage): string | null {
  const m = msg?.message as any;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    null
  );
}
function isStatusJid(jid?: string | null) { return jid === 'status@broadcast'; }

// ---------- Media ----------
async function maybeDownloadMedia(wamessage: WAMessage) {
  const m: any = wamessage.message || {};
  const mediaEntry =
    m.imageMessage || m.videoMessage || m.audioMessage ||
    m.documentMessage || m.stickerMessage || null;
  if (!mediaEntry) return null;

  try {
    // Provide reuploadRequest + logger to satisfy TS typings
    const buffer = await downloadMediaMessage(
      wamessage,
      'buffer',
      {},
      { reuploadRequest: sock!.updateMediaMessage, logger }
    );
    const mt: string = mediaEntry.mimetype || 'application/octet-stream';
    const ext = mime.extension(mt) || 'bin';
    const fname = `${wamessage.key?.id}.${ext}`;
    const fpath = path.join(MEDIA_DIR, fname);
    fs.writeFileSync(fpath, buffer);
    return { file: `/media/${fname}`, mimetype: mt, bytes: buffer.length };
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'media download failed');
    return { error: 'download_failed' as const };
  }
}

// ---------- Boot WA socket ----------
async function startSock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(DATA_DIR);

  let version: [number, number, number] | undefined;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
    logger.info({ version }, 'Using WhatsApp version');
  } catch {
    logger.warn('Could not fetch latest Baileys version — proceeding without pin.');
  }

  sock = makeWASocket({
    logger,
    auth: state,
    version,
    // ---- BRANDING DEVICE NAME ----
    browser: ['Zuria.AI', 'Chrome', '1.0.0'],
    // ------------------------------
    syncFullHistory: true,
    printQRInTerminal: true,
    getMessage: async (key) => {
      if (!key?.remoteJid || !key?.id) return undefined;
      const cached = findMessage(key.remoteJid, key.id);
      return (cached?.raw as any) || undefined;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u as any;
    if (qr) {
      lastQR = qr;
      emitEvent('qr', { qr: true });
      logger.info('QR ready');
    }
    if (connection === 'open') {
      connInfo.status = 'open';
      lastQR = null;
      emitEvent('status', { status: 'open' });
      logger.info('WhatsApp connection OPEN');
    } else if (connection === 'close') {
      const code = (lastDisconnect as any)?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      connInfo.status = 'closed';
      connInfo.reason = (lastDisconnect as any)?.error?.message || 'unknown';
      emitEvent('status', { status: 'closed', reason: connInfo.reason });
      logger.warn({ code }, 'Connection closed');
      if (shouldReconnect) {
        setTimeout(() => startSock().catch((e) => logger.error(e)), 1500);
      } else {
        logger.error('Logged out — rescan at /qr');
      }
    } else if (connection) {
      connInfo.status = connection;
      emitEvent('status', { status: connection });
    }
  });

  // Initial history set
  sock.ev.on('messaging-history.set', async ({ chats: newChats, contacts: newContacts, messages: newMessages }) => {
    if (Array.isArray(newContacts)) {
      for (const c of newContacts as any[]) {
        if (!c?.id) continue;
        contacts[c.id] = {
          jid: c.id,
          name: c.name || c.notify || c.verifiedName || null,
          notify: c.notify || null,
          verifiedName: c.verifiedName || null,
          isBusiness: !!c.isBusiness
        };
      }
      saveContacts();
      emitEvent('contacts.sync', { count: Object.keys(contacts).length });
    }

    if (Array.isArray(newChats)) {
      for (const ch of newChats as any[]) {
        if (!ch?.id || isStatusJid(ch.id)) continue;
        chats[ch.id] = {
          jid: ch.id,
          name: ch.name || contacts[ch.id]?.name || null,
          unreadCount: ch.unreadCount || 0,
          lastMsgTs: ch.conversationTimestamp || Date.now()
        };
      }
      saveChats();
      emitEvent('chats.sync', { count: Object.keys(chats).length });
    }

    if (Array.isArray(newMessages)) {
      for (const m of newMessages as WAMessage[]) {
        const jid = m.key?.remoteJid;
        if (!jid || isStatusJid(jid)) continue;
        const entry: StoredMessage = {
          key: m.key || undefined,
          pushName: (m as any).pushName || null,
          timestamp: Number((m as any).messageTimestamp) * 1000 || Date.now(),
          type: Object.keys(m.message || {})[0] || null,
          text: extractText(m),
          reactions: [],
          raw: m
        };
        if (AUTO_DOWNLOAD_MEDIA) {
          const media = await maybeDownloadMedia(m);
          if (media) entry.media = media;
        }
        appendMessage(jid, entry);
      }
      emitEvent('messages.sync', { added: newMessages.length });
    }
  });

  // Contacts & chats updates
  sock.ev.on('contacts.upsert', (arr: any[]) => {
    for (const c of arr) {
      if (!c?.id) continue;
      contacts[c.id] = {
        jid: c.id,
        name: c.name || c.notify || c.verifiedName || null,
        notify: c.notify || null,
        verifiedName: c.verifiedName || null,
        isBusiness: !!c.isBusiness
      };
    }
    saveContacts();
    emitEvent('contacts.upsert', { count: arr.length });
  });

  sock.ev.on('contacts.update', (arr: any[]) => {
    for (const c of arr) {
      const prev = contacts[c.id] || { jid: c.id };
      contacts[c.id] = {
        ...prev,
        name: c.name ?? prev.name,
        notify: c.notify ?? prev.notify,
        verifiedName: c.verifiedName ?? prev.verifiedName
      };
    }
    saveContacts();
    emitEvent('contacts.update', { count: arr.length });
  });

  sock.ev.on('chats.upsert', (arr: any[]) => {
    for (const ch of arr) {
      if (!ch?.id || isStatusJid(ch.id)) continue;
      chats[ch.id] = {
        jid: ch.id,
        name: ch.name || contacts[ch.id]?.name || null,
        unreadCount: ch.unreadCount || 0,
        lastMsgTs: ch.conversationTimestamp || Date.now()
      };
    }
    saveChats();
    emitEvent('chats.upsert', { count: arr.length });
  });

  sock.ev.on('chats.update', (arr: any[]) => {
    for (const ch of arr) {
      const prev = chats[ch.id] || { jid: ch.id };
      chats[ch.id] = {
        ...prev,
        name: ch.name ?? prev.name,
        unreadCount: ch.unreadCount ?? prev.unreadCount,
        lastMsgTs: ch.conversationTimestamp ?? prev.lastMsgTs
      };
    }
    saveChats();
    emitEvent('chats.update', { count: arr.length });
  });

  sock.ev.on('chats.delete', (arr: string[]) => {
    for (const id of arr) delete chats[id];
    saveChats();
    emitEvent('chats.delete', { count: arr.length });
  });

  // Real-time messages
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages as WAMessage[]) {
      if (!m.message || (m.key as any).fromMe) continue;
      const jid = m.key?.remoteJid;
      if (!jid || isStatusJid(jid)) continue;

      const entry: StoredMessage = {
        key: m.key || undefined,
        pushName: (m as any).pushName || null,
        timestamp: Number((m as any).messageTimestamp) * 1000 || Date.now(),
        type: Object.keys(m.message || {})[0] || null,
        text: extractText(m),
        reactions: [],
        raw: m
      };
      if (AUTO_DOWNLOAD_MEDIA) {
        const media = await maybeDownloadMedia(m);
        if (media) entry.media = media;
      }
      appendMessage(jid, entry);
      emitEvent('message.new', { jid, type: entry.type });

      if (ECHO_REPLY && entry.text) {
        try { await sock!.sendMessage(jid, { text: `Echo: ${entry.text}` }); } catch {}
      }
    }
  });

  // Reactions add/remove
  sock.ev.on('messages.reaction' as any, (arr: any[]) => {
    for (const r of arr) {
      const jid = r.key?.remoteJid;
      const id = r.key?.id;
      if (!jid || !id) continue;
      const msg = findMessage(jid, id);
      if (!msg) continue;
      msg.reactions = msg.reactions || [];
      msg.reactions.push({
        from: r.key.participant || jid,
        emoji: r.reaction?.text || '',
        ts: Date.now()
      });
      appendMessage(jid, msg);
      emitEvent('message.reaction', { jid, id, emoji: r.reaction?.text || '' });
    }
  });

  // Edits (log only)
  sock.ev.on('messages.update', (arr: any[]) => logger.debug({ count: arr.length }, 'messages.update'));

  // Deletes (union type: { keys } | { jid, all: true })
  sock.ev.on('messages.delete', (arg: { keys: WAMessageKey[] } | { jid: string; all: true }) => {
    if ('keys' in arg) {
      logger.debug({ deleted: arg.keys.length }, 'messages.delete (keys)');
    } else {
      logger.debug({ jid: arg.jid, all: true }, 'messages.delete (all in chat)');
    }
  });
}

// ---------- Auth middleware (Bearer) ----------
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!AUTH_TOKEN) return next(); // pas d’auth si vide (dev)
  const hdr = req.get('authorization') || '';
  if (!hdr.startsWith('Bearer ')) return res.status(401).json({ error: 'missing bearer token' });
  const token = hdr.slice('Bearer '.length);
  if (token !== AUTH_TOKEN) return res.status(403).json({ error: 'invalid token' });
  return next();
}

// ---------- HTTP: health & basics ----------
app.get('/health', (_req, res) => res.json({ ok: true, status: connInfo.status }));
app.get('/me', (_req, res) => res.json({ status: connInfo.status, user: (sock as any)?.user || null }));

// QR HTML (auto refresh)
app.get('/qr', async (_req, res) => {
  if (!lastQR) {
    const msg = connInfo.status === 'open' ? 'Déjà lié ✅' : 'QR pas encore prêt — recharge dans 3 s';
    return res.send(`<html><meta http-equiv="refresh" content="3"><body style="font-family:system-ui"><h1>${msg}</h1><p>Status: ${connInfo.status}</p></body></html>`);
  }
  const dataUrl = await qrcode.toDataURL(lastQR, { margin: 1, scale: 8 });
  res.send(`
    <html><head><meta http-equiv="refresh" content="15"></head>
      <body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px">
        <h2>Scanne avec WhatsApp</h2>
        <img src="${dataUrl}" alt="QR" />
        <p>Status: ${connInfo.status}</p>
      </body>
    </html>
  `);
});

// ---------- Static media ----------
app.use('/media', express.static(MEDIA_DIR));

// ---------- Contacts / Chats / Messages (protégés si AUTH_TOKEN défini) ----------
app.get('/contacts', requireAuth, (req, res) => {
  const q = (req.query.q || '').toString().toLowerCase();
  const all = Object.values(contacts);
  const filtered = q
    ? all.filter(c => (c.name || '').toLowerCase().includes(q) || (c.jid || '').includes(q))
    : all;
  res.json({ count: filtered.length, contacts: filtered });
});

app.get('/chats', requireAuth, (_req, res) => {
  res.json({ count: Object.keys(chats).length, chats: Object.values(chats) });
});

app.get('/messages', requireAuth, (req, res) => {
  const jid = (req.query.jid || '').toString();
  if (!jid) return res.status(400).json({ error: 'jid is required' });
  const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
  const before = req.query.before ? parseInt(req.query.before as string, 10) : null;
  const items = readMessages(jid, limit, before ?? undefined);
  res.json({ jid, count: items.length, messages: items });
});

// ---------- Senders ----------
app.post('/send-text', requireAuth, async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'Socket not ready' });
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
    const jid = to.includes('@') ? to : `${String(to).replace(/\D/g, '')}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
    res.json({ ok: true, to: jid });
  } catch (e: any) {
    logger.error(e, 'send-text failed');
    res.status(500).json({ error: e.message });
  }
});

app.post('/send-image', requireAuth, async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'Socket not ready' });
    const { to, url, dataUrl, caption } = req.body || {};
    if (!to || (!url && !dataUrl)) return res.status(400).json({ error: 'to and (url or dataUrl) required' });
    const jid = to.includes('@') ? to : `${String(to).replace(/\D/g, '')}@s.whatsapp.net`;

    if (url) {
      await sock.sendMessage(jid, { image: { url }, caption });
    } else {
      const base64 = String(dataUrl).split(',')[1] || dataUrl;
      const bin = Buffer.from(base64, 'base64');
      await sock.sendMessage(jid, { image: bin, caption });
    }
    res.json({ ok: true, to: jid });
  } catch (e: any) {
    logger.error(e, 'send-image failed');
    res.status(500).json({ error: e.message });
  }
});

// React to a message: { jid, id, emoji }
app.post('/react', requireAuth, async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'Socket not ready' });
    const { jid, id, emoji } = req.body || {};
    if (!jid || !id || !emoji) return res.status(400).json({ error: 'jid, id, emoji are required' });
    const original = findMessage(jid, id);
    if (!original?.key) return res.status(404).json({ error: 'message not found' });
    await sock.sendMessage(jid, { react: { text: emoji, key: original.key! } });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Profile pictures ----------
app.get('/profile-pic', requireAuth, async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'Socket not ready' });
    const jid = (req.query.jid || '').toString();
    if (!jid) return res.status(400).json({ error: 'jid is required' });
    const picUrl = await sock.profilePictureUrl(jid, 'image').catch(() => null);
    res.json({ jid, url: picUrl });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- SSE: live events (QR/status/counts) ----------
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  (res as any).flushHeaders?.();

  const listener = (evt: any) => {
    res.write(`event: ${evt.type}\n`);
    res.write(`data: ${JSON.stringify(evt.payload)}\n\n`);
  };
  bus.on('evt', listener);

  // initial state
  res.write(`event: hello\n`);
  res.write(`data: ${JSON.stringify({ status: connInfo.status, qr: !!lastQR })}\n\n`);

  req.on('close', () => {
    bus.off('evt', listener);
    res.end();
  });
});

// ---------- Boot ----------
(async () => {
  await startSock();
  app.listen(PORT, () => logger.info(`HTTP server listening on :${PORT}`));
})();

// Graceful stop
process.on('SIGTERM', () => logger.info('SIGTERM received'));
