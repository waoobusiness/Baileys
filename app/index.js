const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const mime = require('mime-types');

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  Browsers
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'auth');
const AUTO_DOWNLOAD_MEDIA = process.env.AUTO_DOWNLOAD_MEDIA === '1';

const logger = pino({ level: LOG_LEVEL });
const app = express();
app.use(express.json({ limit: '20mb' }));

// --- Dirs & simple file store (JSON + NDJSON) ---
const STORE_DIR = path.join(DATA_DIR, 'store');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const MSG_DIR = path.join(STORE_DIR, 'messages');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(STORE_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(MSG_DIR, { recursive: true });

const contactsPath = path.join(STORE_DIR, 'contacts.json');
const chatsPath    = path.join(STORE_DIR, 'chats.json');

function readJSON(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }
function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

let contacts = readJSON(contactsPath, {});   // { jid: {jid, name, notify, verifiedName, isBusiness, ...} }
let chats    = readJSON(chatsPath, {});      // { jid: {jid, name, unreadCount, lastMsgTs, ...} }

function saveContacts() { writeJSON(contactsPath, contacts); }
function saveChats()    { writeJSON(chatsPath, chats); }

function msgFile(jid) { return path.join(MSG_DIR, encodeURIComponent(jid) + '.ndjson'); }
function appendMessage(jid, obj) {
  fs.appendFileSync(msgFile(jid), JSON.stringify(obj) + '\n');
}
function readMessages(jid, limit = 50, beforeTs = null) {
  const file = msgFile(jid);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  let arr = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (beforeTs) arr = arr.filter(m => (m.timestamp || 0) < beforeTs);
  return arr.slice(-limit);
}
function findMessage(jid, id) {
  const file = msgFile(jid);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = JSON.parse(lines[i]);
    if (m.key?.id === id) return m;
  }
  return null;
}

// --- WA socket state ---
let sock = null;
let lastQR = null;
let connInfo = { status: 'starting' };

// helpers
function extractText(msg) {
  const m = msg?.message;
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
function isStatusJid(jid) { return jid === 'status@broadcast'; }

async function maybeDownloadMedia(wamessage) {
  const m = wamessage.message || {};
  const mediaEntry =
    m.imageMessage || m.videoMessage || m.audioMessage ||
    m.documentMessage || m.stickerMessage || null;
  if (!mediaEntry) return null;

  try {
    const buffer = await downloadMediaMessage(wamessage, 'buffer', {}, { logger });
    const mt = mediaEntry.mimetype || 'application/octet-stream';
    const ext = mime.extension(mt) || 'bin';
    const fname = `${wamessage.key.id}.${ext}`;
    const fpath = path.join(MEDIA_DIR, fname);
    fs.writeFileSync(fpath, buffer);
    return { file: `/media/${fname}`, mimetype: mt, bytes: buffer.length };
  } catch (e) {
    logger.warn({ err: e?.message }, 'media download failed');
    return { error: 'download_failed' };
  }
}

async function startSock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(DATA_DIR);

  // Important: emulate desktop + full history sync (contacts/chats/messages)
  // per docs: syncFullHistory + desktop browser string
  // https://baileys.wiki/docs/socket/configuration/ ; https://baileys.wiki/docs/socket/history-sync/
  sock = makeWASocket({
    logger,
    auth: state,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: true,
    printQRInTerminal: true,
    // Supply getMessage so Baileys can re-upload missing payloads if needed
    getMessage: async (key) => {
      const jid = key.remoteJid;
      const cached = findMessage(jid, key.id);
      return cached?.raw || undefined;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      lastQR = qr;
      logger.info('QR ready');
    }
    if (connection === 'open') {
      connInfo.status = 'open';
      lastQR = null;
      logger.info('WhatsApp connection OPEN');
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      connInfo.status = 'closed';
      connInfo.reason = lastDisconnect?.error?.message || 'unknown';
      logger.warn({ code }, 'Connection closed');
      if (shouldReconnect) {
        setTimeout(() => startSock().catch(e => logger.error(e)), 1500);
      } else {
        logger.error('Logged out — rescan at /qr');
      }
    } else if (connection) {
      connInfo.status = connection;
    }
  });

  // Initial history (chats, contacts, messages)
  sock.ev.on('messaging-history.set', async ({ chats: newChats, contacts: newContacts, messages: newMessages }) => {
    // contacts
    if (Array.isArray(newContacts)) {
      for (const c of newContacts) {
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
    }
    // chats
    if (Array.isArray(newChats)) {
      for (const ch of newChats) {
        if (!ch?.id || isStatusJid(ch.id)) continue;
        chats[ch.id] = {
          jid: ch.id,
          name: ch.name || contacts[ch.id]?.name || null,
          unreadCount: ch.unreadCount || 0,
          lastMsgTs: ch.conversationTimestamp || Date.now()
        };
      }
      saveChats();
    }
    // messages
    if (Array.isArray(newMessages)) {
      for (const m of newMessages) {
        const jid = m.key?.remoteJid;
        if (!jid || isStatusJid(jid)) continue;
        const entry = {
          key: m.key,
          pushName: m.pushName,
          timestamp: Number(m.messageTimestamp) * 1000 || Date.now(),
          type: Object.keys(m.message || {})[0],
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
    }
  });

  // Contacts updates
  sock.ev.on('contacts.upsert', (arr) => {
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
  });
  sock.ev.on('contacts.update', (arr) => {
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
  });

  // Chats updates
  sock.ev.on('chats.upsert', (arr) => {
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
  });
  sock.ev.on('chats.update', (arr) => {
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
  });
  sock.ev.on('chats.delete', (arr) => {
    for (const id of arr) delete chats[id];
    saveChats();
  });

  // Real-time messages
  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const jid = m.key.remoteJid;
      if (!jid || isStatusJid(jid)) continue;

      const entry = {
        key: m.key,
        pushName: m.pushName,
        timestamp: Number(m.messageTimestamp) * 1000 || Date.now(),
        type: Object.keys(m.message || {})[0],
        text: extractText(m),
        reactions: [],
        raw: m
      };
      if (AUTO_DOWNLOAD_MEDIA) {
        const media = await maybeDownloadMedia(m);
        if (media) entry.media = media;
      }
      appendMessage(jid, entry);

      if (process.env.ECHO_REPLY === '1' && entry.text) {
        try { await sock.sendMessage(jid, { text: `Echo: ${entry.text}` }); } catch {}
      }
    }
  });

  // Edits / deletes / receipts
  sock.ev.on('messages.update', (arr) => {
    // For simplicity, we don't rewrite NDJSON; Supabase will own updates later.
    logger.debug({ count: arr.length }, 'messages.update');
  });
  sock.ev.on('messages.delete', (arr) => {
    logger.debug({ count: arr.length }, 'messages.delete');
  });
  // Reactions (add/remove)
  sock.ev.on('messages.reaction', (arr) => {
    for (const r of arr) {
      const jid = r.key?.remoteJid;
      const id  = r.key?.id;
      if (!jid || !id) continue;
      const msg = findMessage(jid, id);
      if (!msg) continue;
      msg.reactions = msg.reactions || [];
      // r.reaction?.text may be '' when removed
      msg.reactions.push({ from: r.key.participant || jid, emoji: r.reaction?.text || '', ts: Date.now() });
      appendMessage(jid, msg); // append new snapshot; simple approach until DB
    }
  });

  return sock;
}

// --- HTTP endpoints ---
app.get('/health', (req, res) => res.json({ ok: true, status: connInfo.status }));
app.get('/me', (req, res) => res.json({ status: connInfo.status, user: sock?.user || null }));

// QR page
app.get('/qr', async (req, res) => {
  if (!lastQR) {
    const msg = connInfo.status === 'open' ? 'Déjà lié ✅' : 'QR pas encore prêt — recharge dans 3 s';
    return res.send(`<html><meta http-equiv="refresh" content="3"><body style="font-family:system-ui"><h1>${msg}</h1><p>Status: ${connInfo.status}</p></body></html>`);
  }
  const dataUrl = await qrcode.toDataURL(lastQR, { margin: 1, scale: 8 });
  res.send(`
    <html><head><meta http-equiv="refresh" content="15"></head>
    <body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px">
      <h2>Scanne avec WhatsApp</h2>
      <img src="${dataUrl}" alt="QR" /><p>Status: ${connInfo.status}</p>
    </body></html>
  `);
});

// Static media
app.use('/media', express.static(MEDIA_DIR));

// Contacts (q= recherche)
app.get('/contacts', (req, res) => {
  const q = (req.query.q || '').toString().toLowerCase();
  const all = Object.values(contacts);
  const filtered = q
    ? all.filter(c => (c.name || '').toLowerCase().includes(q) || (c.jid || '').includes(q))
    : all;
  res.json({ count: filtered.length, contacts: filtered });
});

// Chats
app.get('/chats', (req, res) => res.json({ count: Object.keys(chats).length, chats: Object.values(chats) }));

// Messages d’un chat
app.get('/messages', (req, res) => {
  const jid = (req.query.jid || '').toString();
  if (!jid) return res.status(400).json({ error: 'jid is required' });
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;
  const items = readMessages(jid, limit, before);
  res.json({ jid, count: items.length, messages: items });
});

// Envoyer texte
app.post('/send-text', async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'Socket not ready' });
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
    const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
    res.json({ ok: true, to: jid });
  } catch (e) {
    logger.error(e, 'send-text failed');
    res.status(500).json({ error: e.message });
  }
});

// Réagir à un message
// body: { jid, id, emoji }
app.post('/react', async (req, res) => {
  try {
    const { jid, id, emoji } = req.body || {};
    if (!jid || !id || !emoji) return res.status(400).json({ error: 'jid, id, emoji are required' });
    const original = findMessage(jid, id);
    if (!original?.key) return res.status(404).json({ error: 'message not found' });
    await sock.sendMessage(jid, { react: { text: emoji, key: original.key } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

(async () => {
  await startSock();
  app.listen(PORT, () => logger.info(`HTTP server listening on :${PORT}`));
})();

process.on('SIGTERM', () => logger.info('SIGTERM received'));
