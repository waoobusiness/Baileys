// src/server.ts
import 'dotenv/config'
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import pino from 'pino'
import { Boom } from '@hapi/boom'
import {
  WASocket,
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WAMessageKey,
  proto,
} from '@whiskeysockets/baileys'
import fsp from 'fs/promises'
import path from 'path'

/* ------------------------- logger & app ------------------------- */
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })
const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(function jsonParseErrorHandler(err: any, _req: Request, res: Response, next: NextFunction) {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'invalid_json_body' })
  }
  return next(err)
})

/* --------------------------- security -------------------------- */
const AUTH_TOKEN =
  process.env.RESOLVER_BEARER ||
  process.env.AUTH_TOKEN ||
  'MY_PRIVATE_FURIA_API_KEY_2025'

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const hdr = (req.headers['authorization'] || '').toString()
  const got = hdr.startsWith('Bearer ') ? hdr.slice(7) : ''
  if (!got || got !== AUTH_TOKEN) return res.status(403).json({ ok: false, error: 'forbidden' })
  next()
}

/* ------------------------ WA in-memory data --------------------- */
let sock: WASocket | null = null
const AUTH_DIR = path.join(process.cwd(), 'auth')

type Contact = { id: string; name?: string; notify?: string; verifiedName?: string; isBusiness?: boolean }
type Chat    = { jid: string; name?: string; unreadCount?: number; lastMsgTs?: number }

const contactsMap = new Map<string, Contact>()
const chatsMap    = new Map<string, Chat>()
const msgMap      = new Map<string, any[]>()

const MSG_CAP = 200
let currentQR: string | null = null
let qrStatus: 'idle' | 'pending' | 'open' | 'closed' = 'idle'

/* --------------------------- helpers ---------------------------- */
function toJid(input: string): string {
  if (!input) throw new Error('destination manquante')
  const s = input.trim()
  if (s.endsWith('@s.whatsapp.net') || s.endsWith('@g.us')) return s
  const num = s.replace(/\D/g, '')
  if (!num) throw new Error('numéro invalide')
  return `${num}@s.whatsapp.net`
}
function pushMessage(m: any) {
  const jid = m?.key?.remoteJid || ''
  if (!jid) return
  const arr = msgMap.get(jid) || []
  arr.push(m)
  if (arr.length > MSG_CAP) arr.splice(0, arr.length - MSG_CAP)
  msgMap.set(jid, arr)
}
async function resetAuthFolder() {
  try { await fsp.rm(AUTH_DIR, { recursive: true, force: true }) } catch {}
  await fsp.mkdir(AUTH_DIR, { recursive: true })
}

/* ----------------------- WA connection flow --------------------- */
async function connectWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()
  logger.info({ version }, 'Using WhatsApp version')

  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    browser: ['Zuria.AI', 'Chrome', '1.0.0'],
    auth: state,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldIgnoreJid: () => false,
    getMessage: async (key: WAMessageKey): Promise<proto.IMessage | undefined> => {
      const jid = key.remoteJid || ''
      const arr = msgMap.get(jid) || []
      const found = arr.find((m: any) => m?.key?.id === key.id)
      return (found?.message as proto.IMessage) ?? undefined
    },
  })
  const ev: any = sock.ev
  ev.on('creds.update', saveCreds)
  ev.on('contacts.set', ({ contacts }: any) => {
    for (const c of contacts || []) {
      if (!c?.id) continue
      contactsMap.set(c.id, { id: c.id, name: c.name, notify: c.notify, verifiedName: c.verifiedName, isBusiness: c.isBusiness })
    }
  })
  ev.on('contacts.update', (updates: any[]) => {
    for (const u of updates || []) {
      if (!u?.id) continue
      const prev = contactsMap.get(u.id) || { id: u.id }
      contactsMap.set(u.id, { ...(prev as Contact), ...(u as Partial<Contact>) })
    }
  })
  ev.on('chats.set', ({ chats }: any) => {
    for (const c of chats || []) {
      chatsMap.set(c.id, { jid: c.id, name: c.name, unreadCount: c.unreadCount, lastMsgTs: c.lastMsgRecv } as Chat)
    }
  })
  ev.on('chats.upsert', (chs: any[]) => {
    for (const c of chs || []) {
      chatsMap.set(c.id, { jid: c.id, name: c.name, unreadCount: c.unreadCount, lastMsgTs: c.lastMsgRecv } as Chat)
    }
  })
  ev.on('chats.update', (chs: any[]) => {
    for (const c of chs || []) {
      const prev = (chatsMap.get(c.id) as Chat) || ({ jid: c.id } as Chat)
      chatsMap.set(c.id, { ...prev, name: (c.name ?? prev.name) } as Chat)
    }
  })
  ev.on('messages.set', ({ messages }: any) => { for (const m of messages || []) pushMessage(m) })
  ev.on('messages.upsert', ({ messages }: any) => { for (const m of messages || []) pushMessage(m) })
  ev.on('messages.update', (updates: any[]) => {
    for (const u of updates || []) {
      const jid = u?.key?.remoteJid || ''
      const arr = msgMap.get(jid)
      if (!arr) continue
      const idx = arr.findIndex((m: any) => m?.key?.id === u?.key?.id)
      if (idx >= 0) arr[idx] = { ...arr[idx], ...u }
    }
  })
  ev.on('connection.update', async (u: any) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) { currentQR = qr; qrStatus = 'pending'; logger.info('QR ready') }
    if (connection === 'open') { logger.info('WhatsApp connection OPEN'); qrStatus = 'open'; currentQR = null; return }
    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      logger.warn({ code, reason: (DisconnectReason as any)[code || ''] }, 'connection closed')
      if (code === 515 || code === DisconnectReason.restartRequired) { setTimeout(connectWA, 500); return }
      if (code === 401 || code === DisconnectReason.loggedOut) { await resetAuthAndRestart(); return }
      setTimeout(connectWA, 1000)
    }
  })
}
async function resetAuthAndRestart() {
  try { if (sock) await sock.logout() } catch {}
  await resetAuthFolder()
  currentQR = null
  qrStatus = 'pending'
  await connectWA()
}

/* ----------------------------- routes WA ------------------------ */
app.get('/health', (_req, res) => {
  res.json({ ok: true, status: qrStatus, connected: Boolean(sock?.user), user: sock?.user || null })
})
app.get('/qr', (_req, res) => {
  if (qrStatus === 'open') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(`<html><head><meta charset="utf-8"><title>WA QR</title>
      <style>body{font-family:system-ui,Arial;padding:24px}img{border:8px solid #eee;border-radius:16px}</style>
      </head><body><h1>Déjà lié ✅</h1><p>Status: open</p></body></html>`)
  }
  const q = currentQR ? encodeURIComponent(currentQR) : ''
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<html><head><meta charset="utf-8"><title>WA QR</title>
    <style>body{font-family:system-ui,Arial;padding:24px}img{border:8px solid #eee;border-radius:16px}</style>
    </head><body><h1>Scanne avec WhatsApp</h1>
    ${currentQR ? `<img width="320" height="320" src="https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${q}" />` : `<p>QR non prêt…</p>`}
    <p>Status: ${qrStatus}</p></body></html>`)
})
app.get('/qr/json', (_req, res) => { res.json({ status: qrStatus, qr: currentQR }) })
app.post('/session/reset', requireAuth, async (_req, res) => { await resetAuthAndRestart(); res.json({ ok: true }) })
app.post('/session/reconnect', requireAuth, async (_req, res) => { connectWA(); res.json({ ok: true }) })

/* ----------------------- CARS RESOLVER -------------------------- */
const RESOLVER_BEARER = process.env.RESOLVER_BEARER || AUTH_TOKEN
function requireResolverAuth(req: Request, res: Response, next: NextFunction) {
  const h = String(req.headers.authorization || ''); const t = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (!RESOLVER_BEARER) return res.status(500).json({ ok:false, error:'resolver_bearer_not_set' })
  if (t !== RESOLVER_BEARER) return res.status(401).json({ ok:false, error:'unauthorized' })
  next()
}

app.get('/cars/health', (_req, res) => res.json({ ok: true, service: 'cars-resolver', ts: Date.now() }))

// GET test: /cars/connect?link=...
app.get('/cars/connect', requireResolverAuth, async (req, res) => {
  const link = String((req.query.link || req.query.url || req.query.href || '') as string).trim()
  if (!link) return res.status(400).json({ ok: false, error: 'link required' })
  return connectFromLink(link, res)
})

// POST contractuel
app.post('/cars/connect', requireResolverAuth, async (req, res) => {
  const raw = (req.body ?? {}) as Record<string, unknown>
  const link = String((raw.link || raw.url || raw.href || '') as string || '').trim()
  if (!link) return res.status(400).json({ ok:false, error:'link required' })
  return connectFromLink(link, res)
})

/* ----------------------- Scraper utilities ---------------------- */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36'

async function fetchHtml(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'fr-CH,fr;q=0.9,en;q=0.8' } })
  if (!r.ok) throw new Error(`fetch_failed_${r.status}`)
  return await r.text()
}
function absoluteAutoscoutUrl(href: string): string {
  if (!href) return href
  if (/^https?:\/\//i.test(href)) return href
  if (href.startsWith('/')) return `https://www.autoscout24.ch${href}`
  return `https://www.autoscout24.ch/${href}`
}
function getTitle(html: string): string | undefined {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i)
  return m ? m[1].trim() : undefined
}
// Extract ALL JSON-LD blocks safely
function getAllJsonLd(html: string): any[] {
  const out: any[] = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] || '').trim()
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) out.push(...parsed)
      else out.push(parsed)
    } catch { /* ignore broken ld-json */ }
  }
  return out
}
function findLdOfType(lds: any[], types: string[]): any | undefined {
  for (const ld of lds) {
    const t = (ld?.['@type'] || ld?.type)
    if (!t) continue
    if (Array.isArray(t)) { if (t.some((x: string) => types.includes(x))) return ld }
    else if (types.includes(String(t))) return ld
  }
  return undefined
}
function parsePrice(offers: any): { price?: number; currency?: string } {
  if (!offers) return {}
  if (Array.isArray(offers)) {
    for (const o of offers) {
      const p = Number(o?.price); if (p) return { price: p, currency: o?.priceCurrency || o?.priceCurrency?.code }
    }
    return {}
  }
  const price = Number(offers.price)
  const currency = offers.priceCurrency || offers.priceCurrency?.code
  return { price: Number.isFinite(price) ? price : undefined, currency }
}
function parseMileage(m: any): { mileage_km?: number } {
  if (!m) return {}
  const val = Number(m?.value || m?.valueReference || m)
  const unit = (m?.unitCode || m?.unitText || '').toString().toUpperCase()
  if (Number.isFinite(val)) {
    if (unit.includes('KMT') || unit.includes('KM') || unit.includes('KILOMETER')) return { mileage_km: val }
    if (unit.includes('MI')) return { mileage_km: Math.round(val * 1.60934) }
  }
  return {}
}
function idFromUrl(url: string): string | undefined {
  // ex: /fr/d/vw-eos-20-fsi-12883342
  const m = url.match(/\/d\/[^/]*?(\d{6,})/i)
  return m?.[1]
}
function mapCarFromLd(ld: any, pageUrl: string): any {
  if (!ld) return {}
  const brand = typeof ld.brand === 'string' ? ld.brand : (ld.brand?.name || ld.brand?.brand || undefined)
  const model = ld.model || ld.vehicleModel || ld.name?.replace(new RegExp(String(brand || ''), 'i'), '').trim()
  const { price, currency } = parsePrice(ld.offers || ld.priceSpecification || ld.offersSpecification)
  const { mileage_km } = parseMileage(ld.mileageFromOdometer)
  const year = Number(ld.productionDate || ld.modelDate || (ld.vehicleConfiguration?.year || ld.vehicleIdentificationNumber?.year))
  const images = Array.isArray(ld.image) ? ld.image : (ld.image ? [ld.image] : [])
  const seller = ld.seller || ld.provider || ld.brandOwner
  const dealer_name = typeof seller === 'string' ? seller : (seller?.name || undefined)
  const addr = seller?.address || ld.address
  const address = addr ? {
    streetAddress: addr.streetAddress, postalCode: addr.postalCode, addressLocality: addr.addressLocality, addressCountry: addr.addressCountry
  } : undefined
  const fuel = ld.fuelType || ld.vehicleFuelType
  const transmission = ld.vehicleTransmission
  const body = ld.bodyType || ld.bodyConfiguration
  const power = Number(ld.enginePower?.value || ld.engineDisplacement?.value)
  const url = pageUrl
  const listing_id = idFromUrl(pageUrl)
  const title = ld.name
  return {
    listing_id, title, brand, model, year: Number.isFinite(year) ? year : undefined,
    price, currency, mileage_km, fuel, transmission, body,
    power_hp: Number.isFinite(power) ? power : undefined,
    images, dealer_name, address, url
  }
}
function mapDealerFromLd(ld: any, pageUrl: string): any {
  if (!ld) return {}
  const addr = ld.address
  const address = addr ? {
    streetAddress: addr.streetAddress, postalCode: addr.postalCode, addressLocality: addr.addressLocality, addressCountry: addr.addressCountry
  } : undefined
  const geo = ld.geo ? { lat: Number(ld.geo.latitude), lng: Number(ld.geo.longitude) } : undefined
  return {
    name: ld.name || getTitle, url: pageUrl, telephone: ld.telephone || ld.contactPoint?.telephone,
    email: ld.email, address, geo
  }
}
function extractListingLinks(html: string, limit = 10): string[] {
  const set = new Set<string>()
  const reAbs = /href=["'](https?:\/\/www\.autoscout24\.ch\/[^"']*?\/d\/[^"']+)["']/gi
  const reRel = /href=["'](\/[a-z]{2}\/d\/[^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = reAbs.exec(html)) !== null) { set.add(m[1]) ; if (set.size >= limit) break }
  if (set.size < limit) {
    while ((m = reRel.exec(html)) !== null) { set.add(absoluteAutoscoutUrl(m[1])); if (set.size >= limit) break }
  }
  return Array.from(set)
}

/* --------------------- Main resolver handler -------------------- */
async function connectFromLink(link: string, res: Response) {
  try {
    const url = link.trim()
    if (!/autoscout24\.ch/i.test(url)) {
      return res.status(422).json({ ok:false, error:'site_not_supported', site:url })
    }
    const html = await fetchHtml(url)
    const lds = getAllJsonLd(html)

    const isListing = /\/d\//i.test(url)
    if (isListing) {
      // Try Car/Vehicle/Product JSON-LD
      const ldCar = findLdOfType(lds, ['Car','Vehicle','Product'])
      if (ldCar) {
        const car = mapCarFromLd(ldCar, url)
        // minimal fallback for title if empty
        if (!car.title) car.title = getTitle(html)
        return res.json({ ok:true, site:'autoscout24', kind:'listing', link:url, car })
      }
      // Fallback: minimal response to avoid “impossible…”
      return res.json({ ok:true, site:'autoscout24', kind:'listing', link:url, car: { url, listing_id: idFromUrl(url), title: getTitle(html) } })
    }

    // Dealer / Garage page
    const ldDealer = findLdOfType(lds, ['AutoDealer','LocalBusiness','Organization'])
    let dealer = ldDealer ? mapDealerFromLd(ldDealer, url) : { name: getTitle(html), url }
    // Inventory preview (just links)
    const links = extractListingLinks(html, 10)
    const inventory_preview = links.map(u => ({ url: u, listing_id: idFromUrl(u) }))

    if (!dealer?.name) dealer.name = getTitle(html)
    return res.json({ ok:true, site:'autoscout24', kind:'garage', link:url, dealer, inventory_preview })
  } catch (e: any) {
    const msg = e?.message || 'unknown'
    if (msg.startsWith('fetch_failed_')) return res.status(502).json({ ok:false, error:'upstream_fetch_failed', details: msg })
    return res.status(500).json({ ok:false, error:'resolver_crash', details: msg })
  }
}

/* --------- sending: text / image / audio / PTT / reaction ------ */
app.post('/send-text', requireAuth, async (req, res) => {
  try {
    const jid = toJid(req.body.to); const text = (req.body.text || '').toString()
    if (!sock) throw new Error('socket not ready')
    await sock.sendMessage(jid, { text }); res.json({ ok: true })
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message }) }
})
app.post('/send-image', requireAuth, async (req, res) => {
  try {
    const jid = toJid(req.body.to); const url = (req.body.url || '').toString()
    const caption = (req.body.caption || '').toString()
    if (!sock) throw new Error('socket not ready')
    await sock.sendMessage(jid, { image: { url }, caption }); res.json({ ok: true })
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message }) }
})
app.post('/send-audio', requireAuth, async (req, res) => {
  try {
    const jid = toJid(req.body.to); const url = (req.body.url || '').toString()
    if (!sock) throw new Error('socket not ready')
    await sock.sendMessage(jid, { audio: { url }, mimetype: 'audio/mpeg' }); res.json({ ok: true })
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message }) }
})
app.post('/send-ptt', requireAuth, async (req, res) => {
  try {
    const jid = toJid(req.body.to); const url = (req.body.url || '').toString()
    if (!sock) throw new Error('socket not ready')
    await sock.sendMessage(jid, { audio: { url }, ptt: true, mimetype: 'audio/ogg' }); res.json({ ok: true })
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message }) }
})
app.post('/react', requireAuth, async (req, res) => {
  try {
    if (!sock) throw new Error('socket not ready')
    const jid = toJid(req.body.jid); const id = (req.body.id || '').toString()
    const emoji = (req.body.emoji || '').toString()
    const participant = (req.body.participant || '').toString() || undefined
    const key: WAMessageKey = { id, remoteJid: jid, fromMe: false, participant }
    await sock.sendMessage(jid, { react: { text: emoji, key } }); res.json({ ok: true })
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message }) }
})

/* ---------------------- data listing APIs ---------------------- */
app.get('/contacts', requireAuth, (_req, res) => {
  const contacts = Array.from(contactsMap.values()); res.json({ count: contacts.length, contacts })
})
app.get('/chats', requireAuth, (_req, res) => {
  const chats = Array.from(chatsMap.values()); res.json({ count: chats.length, chats })
})
app.get('/messages', requireAuth, async (req, res) => {
  try {
    const jid = toJid((req.query.jid || '').toString())
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 200))
    const arr = (msgMap.get(jid) || []).slice(-limit)
    res.json({ jid, count: arr.length, messages: arr })
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message }) }
})

/* ---------------------------- start ---------------------------- */
const PORT = Number(process.env.PORT || 10000)
app.listen(PORT, () => logger.info(`HTTP server listening on :${PORT}`))
connectWA().catch(err => logger.error(err, 'connectWA failed'))
