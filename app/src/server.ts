// src/server.ts
import 'dotenv/config'
import express, { Request, Response, NextFunction } from 'express'
import carsConnectRouter, { carsConnectParsers } from "./cars-connect";
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
app.use(carsConnectParsers);
app.use("/cars", carsConnectRouter);
app.use(cors())
app.use(express.json({ limit: '10mb' }))

/* --------------------------- security -------------------------- */
// Accept either RESOLVER_BEARER (for Lovable) or AUTH_TOKEN (manual/testing)
const AUTH_TOKEN =
  process.env.RESOLVER_BEARER ||
  process.env.AUTH_TOKEN ||
  'MY_PRIVATE_FURIA_API_KEY_2025'

// Token spécifique pour /cars/*
const RESOLVER_BEARER = process.env.RESOLVER_BEARER || ''
// Fallback proxy pour contourner les 403 (ex: Supabase Edge function "html-proxy")
const CARS_PROXY_URL = process.env.CARS_PROXY_URL || '' // ex: https://<project>.functions.supabase.co/html-proxy

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const hdr = (req.headers['authorization'] || '').toString()
  const got = hdr.startsWith('Bearer ') ? hdr.slice(7) : ''
  if (!got || got !== AUTH_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  next()
}

function requireResolverAuth(req: Request, res: Response, next: NextFunction) {
  const h = String(req.headers.authorization || '')
  const t = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (!RESOLVER_BEARER) return res.status(500).json({ ok:false, error:'resolver bearer not set' })
  if (t !== RESOLVER_BEARER) return res.status(401).json({ ok:false, error:'unauthorized' })
  next()
}

/* ------------------------ WA in-memory data --------------------- */
let sock: WASocket | null = null
const AUTH_DIR = path.join(process.cwd(), 'auth')

type Contact = { id: string; name?: string; notify?: string; verifiedName?: string; isBusiness?: boolean }
type Chat    = { jid: string; name?: string; unreadCount?: number; lastMsgTs?: number }

const contactsMap = new Map<string, Contact>()
const chatsMap    = new Map<string, Chat>()
const msgMap      = new Map<string, any[]>() // messages par JID (web messages entiers)

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
      contactsMap.set(c.id, {
        id: c.id,
        name: c.name,
        notify: c.notify,
        verifiedName: c.verifiedName,
        isBusiness: c.isBusiness,
      })
    }
  })

  ev.on('contacts.update', (updates: any[]) => {
    for (const u of updates || []) {
      if (!u?.id) continue
      const prev = contactsMap.get(u.id) || { id: u.id }
      contactsMap.set(u.id, { ...(prev as Contact), ...(u as Partial<Contact>) })
    }
  })

  ev.on('chats.set', ({ chats, isLatest }: any) => {
    for (const c of chats || []) {
      chatsMap.set(c.id, {
        jid: c.id,
        name: c.name,
        unreadCount: c.unreadCount,
        lastMsgTs: c.lastMsgRecv,
      } as Chat)
    }
    logger.info({ count: (chats || []).length, isLatest }, 'chats.set')
  })

  ev.on('chats.upsert', (chs: any[]) => {
    for (const c of chs || []) {
      chatsMap.set(c.id, {
        jid: c.id,
        name: c.name,
        unreadCount: c.unreadCount,
        lastMsgTs: c.lastMsgRecv,
      } as Chat)
    }
  })

  ev.on('chats.update', (chs: any[]) => {
    for (const c of chs || []) {
      const prev = (chatsMap.get(c.id) as Chat) || ({ jid: c.id } as Chat)
      chatsMap.set(c.id, { ...prev, name: (c.name ?? prev.name) } as Chat)
    }
  })

  ev.on('messages.set', ({ chats, messages, isLatest }: any) => {
    for (const m of messages || []) pushMessage(m)
    logger.info({ chats: (chats || []).length, messages: (messages || []).length, isLatest }, 'messages.set')
  })

  ev.on('messages.upsert', ({ messages }: any) => {
    for (const m of messages || []) pushMessage(m)
  })

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

    if (qr) {
      currentQR = qr
      qrStatus = 'pending'
      logger.info('QR ready')
    }

    if (connection === 'open') {
      logger.info('WhatsApp connection OPEN')
      qrStatus = 'open'
      currentQR = null
      return
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      logger.warn({ code, reason: (DisconnectReason as any)[code || ''] }, 'connection closed')

      if (code === 515 || code === DisconnectReason.restartRequired) {
        setTimeout(connectWA, 500)
        return
      }
      if (code === 401 || code === DisconnectReason.loggedOut) {
        await resetAuthAndRestart()
        return
      }
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

/* ----------------------------- routes --------------------------- */
app.get('/health', (_req, res) => {
  res.json({ ok: true, status: qrStatus, connected: Boolean(sock?.user), user: sock?.user || null })
})

app.get('/qr', (_req, res) => {
  if (qrStatus === 'open') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(`
      <html><head><meta charset="utf-8"><title>WA QR</title>
      <style>body{font-family:system-ui,Arial;padding:24px}img{border:8px solid #eee;border-radius:16px}</style>
      </head><body>
      <h1>Déjà lié ✅</h1>
      <p>Status: open</p>
      </body></html>
    `)
  }
  const q = currentQR ? encodeURIComponent(currentQR) : ''
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`
    <html><head><meta charset="utf-8"><title>WA QR</title>
    <style>body{font-family:system-ui,Arial;padding:24px}img{border:8px solid #eee;border-radius:16px}</style>
    </head><body>
      <h1>Scanne avec WhatsApp</h1>
      ${currentQR ? `<img width="320" height="320" src="https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${q}" />`
                   : `<p>QR non prêt…</p>`}
      <p>Status: ${qrStatus}</p>
    </body></html>
  `)
})

app.get('/qr/json', (_req, res) => {
  res.json({ status: qrStatus, qr: currentQR })
})

app.post('/session/reset', requireAuth, async (_req, res) => {
  await resetAuthAndRestart()
  res.json({ ok: true })
})

app.post('/session/reconnect', requireAuth, async (_req, res) => {
  connectWA()
  res.json({ ok: true })
})

/* ----------------------- CARS RESOLVER ------------------------ */
// Santé
app.get('/cars/health', (_req, res) => {
  res.json({ ok: true, service: 'cars-resolver', ts: Date.now(), proxy: !!CARS_PROXY_URL })
})

type CarNormalized = {
  url?: string
  title?: string
  brand?: string
  model?: string
  version?: string
  year?: number
  mileage_km?: number
  fuel?: string
  gearbox?: string
  body?: string
  power_hp?: number
  price?: number
  currency?: string
  images?: string[]
  location?: string
  seller?: { name?: string; type?: string }
}

type InventoryPreview = {
  url: string
  title?: string
  price?: number
  currency?: string
}

app.post('/cars/connect', requireResolverAuth, async (req, res) => {
  try {
    const link = String(req.body?.link || '')
    if (!link) return res.status(400).json({ ok:false, error:'link required' })

    const { ok, status, html, viaProxy } = await smartGetHtml(link)
    if (!ok || !html) {
      return res.status(502).json({ ok:false, error:'upstream_fetch_failed', details: status === 403 ? 'fetch_failed_403' : `status_${status}` })
    }

    // 1) NEXT_DATA (Next.js)
    const next = extractNextJSON(html)
    if (next) {
      const carFromNext = extractCarFromNext(next) // heuristique
      if (carFromNext) return res.json({ ok:true, kind:'listing', viaProxy, car: carFromNext })
      const invFromNext = extractInventoryFromNext(next)
      if (invFromNext?.length) return res.json({ ok:true, kind:'garage', viaProxy, dealer: guessDealer(html, next), inventory_preview: invFromNext.slice(0, 20) })
    }

    // 2) JSON-LD (peut être multiple)
    const lds = extractAllJsonLd(html)
    // chercher VEHICLE ou PRODUCT
    const carFromLd = lds.map(mapLdToCar).find(Boolean)
    if (carFromLd) return res.json({ ok:true, kind:'listing', viaProxy, car: carFromLd })

    // 3) Inventory / ItemList
    const invLD = lds.find(ld => isItemList(ld))
    if (invLD) {
      const dealer = guessDealer(html, undefined, invLD)
      const preview = fromItemList(invLD)
      if (preview.length) return res.json({ ok:true, kind:'garage', viaProxy, dealer, inventory_preview: preview.slice(0, 20) })
    }

    // 4) Fallback: heuristique de liens de fiches
    const invFallback = scrapeDealerInventory(html, link)
    if (invFallback.length) {
      return res.json({ ok:true, kind:'garage', viaProxy, dealer: guessDealer(html), inventory_preview: invFallback.slice(0, 20) })
    }

    return res.status(422).json({ ok:false, error:'unrecognized_autoscout24_page' })
  } catch (e:any) {
    logger.error({ err: e?.message, stack: e?.stack }, 'cars_connect_crash')
    res.status(500).json({ ok:false, error:'resolver_crash', details:e?.message })
  }
})

/* --------------------- fetch & parsing helpers ------------------ */
async function smartGetHtml(url: string): Promise<{ ok: boolean; status?: number; html?: string; viaProxy?: boolean }> {
  const headers: Record<string,string> = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'fr-CH,fr;q=0.9,en;q=0.8,de;q=0.7',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
  }

  try {
    const r = await fetch(url, { headers, redirect: 'follow' as RequestRedirect })
    if (r.status === 200) {
      const html = await r.text()
      return { ok: true, status: 200, html, viaProxy: false }
    }
    // 301/302 suivis automatiquement; si 403 → fallback proxy
    if (r.status === 403 || r.status === 503) {
      if (!CARS_PROXY_URL) return { ok:false, status: r.status }
      // proxy simple: GET ?url=encoded
      const pr = await fetch(`${CARS_PROXY_URL}?url=${encodeURIComponent(url)}`, { headers: { 'x-resolver-bearer': RESOLVER_BEARER } })
      if (!pr.ok) return { ok:false, status: pr.status }
      const ct = pr.headers.get('content-type') || ''
      if (ct.includes('application/json')) {
        const j = await pr.json()
        const body = j?.body ?? j?.html ?? ''
        if (typeof body === 'string' && body.length) return { ok:true, status: 200, html: body, viaProxy: true }
        return { ok:false, status: 502 }
      } else {
        const body = await pr.text()
        if (body) return { ok:true, status: 200, html: body, viaProxy: true }
        return { ok:false, status: 502 }
      }
    }
    // autres codes
    const txt = await r.text().catch(() => '')
    logger.warn({ status: r.status, len: txt?.length }, 'smartGetHtml_non200')
    return { ok:false, status: r.status }
  } catch (e:any) {
    logger.error({ err: e?.message }, 'smartGetHtml_error')
    return { ok:false, status: 599 }
  }
}

function extractNextJSON(html: string): any | null {
  const re = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  const m = html.match(re)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch { return null }
}

function extractAllJsonLd(html: string): any[] {
  const out: any[] = []
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const raw = m[1]
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) out.push(...parsed)
      else out.push(parsed)
    } catch {
      // rien
    }
  }
  return out
}

function isItemList(ld: any): boolean {
  const t = (ld?.['@type'] || '').toString().toLowerCase()
  return t === 'itemlist'
}

function deepPick(obj: any, keys: string[]): any {
  // Cherche la première clé dispo (profondeur limitée)
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of keys) {
    if (obj && typeof obj === 'object' && k in obj) return (obj as any)[k]
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = deepPick(v, keys)
      if (r !== undefined) return r
    }
  }
  return undefined
}

function getNum(val: any): number | undefined {
  if (val === null || val === undefined) return undefined
  const s = String(val).replace(/\s/g, '')
  const m = s.match(/-?\d+(?:[.,]\d+)?/)
  if (!m) return undefined
  const n = Number(m[0].replace(',', '.'))
  return isNaN(n) ? undefined : n
}

function toInt(val: any): number | undefined {
  const n = getNum(val)
  return n !== undefined ? Math.round(n) : undefined
}

function upperOrUndef(s: any): string | undefined {
  const v = (s ?? '').toString().trim()
  return v ? v.toUpperCase() : undefined
}

/* --------------------- mapping: JSON-LD → Car ------------------- */
function mapLdToCar(ld: any): CarNormalized | null {
  if (!ld || typeof ld !== 'object') return null
  const type = (ld['@type'] || '').toString().toLowerCase()
  if (!['vehicle', 'product', 'car'].includes(type)) return null

  const brand = ld.brand?.name || ld.brand
  const model = ld.model || ld.vehicleModel || ld.name
  const year  = toInt(ld.modelDate || ld.vehicleModelDate || ld.productionDate || ld.releaseDate)

  // price
  let price = getNum(ld.offers?.price)
  let currency = upperOrUndef(ld.offers?.priceCurrency)

  // mileage
  const mObj = ld.mileageFromOdometer
  const mileage_km = mObj?.value ? toInt(mObj.value) : toInt(ld.mileage || ld.mileageFromOdometer)

  const fuel = ld.fuelType || ld.fuel || undefined
  const gearbox = ld.vehicleTransmission || ld.transmission || undefined
  const power_hp = toInt(ld.power) || toInt(ld.enginePower?.value)
  const images = Array.isArray(ld.image) ? ld.image : (ld.image ? [ld.image] : undefined)

  const sellerName = ld.seller?.name || ld.brand?.name
  const sellerType = ld.seller?.['@type']

  const title = ld.name || [brand, model, year].filter(Boolean).join(' ')
  const url = ld.url

  if (!brand && !model && !price && !year && !images?.length) {
    // trop faible → considérer non pertinent
    return null
  }

  return {
    url, title,
    brand, model,
    version: undefined,
    year: year,
    mileage_km,
    fuel: fuel?.toString(),
    gearbox: gearbox?.toString(),
    body: ld.bodyType || undefined,
    power_hp,
    price,
    currency,
    images,
    location: ld.offers?.availableAtOrFrom?.address?.addressLocality,
    seller: (sellerName || sellerType) ? { name: sellerName, type: sellerType } : undefined,
  }
}

/* -------------- mapping: ItemList(JSON-LD) → inventory --------- */
function fromItemList(ld: any): InventoryPreview[] {
  const items: InventoryPreview[] = []
  const list = Array.isArray(ld?.itemListElement) ? ld.itemListElement : []
  for (const el of list) {
    const item = el?.item || el
    if (!item) continue

    const url = (item.url || el.url || '').toString()
    if (!url) continue

    const title = (item.name || el.name || '').toString() || undefined
    const price = getNum(item?.offers?.price ?? el?.offers?.price)

    // Ne pas mélanger ?? et || sans parenthèses (TS5076)
    const currencyRaw = (item?.offers?.priceCurrency ?? el?.offers?.priceCurrency ?? '')
    const currency = String(currencyRaw).toUpperCase() || undefined

    items.push({ url, title, price, currency })
  }
  return items
}

/* --------------------- NEXT_DATA → Car / Inventory ------------- */
function extractCarFromNext(next: any): CarNormalized | null {
  if (!next || typeof next !== 'object') return null
  // Heuristique : chercher un objet "listing"/"ad"/"vehicle" avec marque, modèle, prix
  const candidate = deepPick(next, ['listing', 'ad', 'vehicle', 'car', 'detail'])
  if (!candidate || typeof candidate !== 'object') return null

  const brand = candidate.brand?.name || candidate.brand || candidate.makeName || candidate.make
  const model = candidate.modelName || candidate.model || candidate.type
  const year  = toInt(candidate.firstRegistrationYear || candidate.year || candidate.registrationYear)
  const mileage_km = toInt(candidate.mileage || candidate.mileageKm || candidate.odometer)
  const price = getNum(candidate.price?.amount ?? candidate.price ?? candidate.priceValue)
  const currency = upperOrUndef(candidate.price?.currency ?? candidate.currency)
  const title = candidate.title || [brand, model, year].filter(Boolean).join(' ')
  const images = Array.isArray(candidate.images)
    ? candidate.images.map((i:any) => i?.url || i).filter(Boolean)
    : undefined

  if (!brand && !model && !price && !year && !images?.length) return null

  return {
    title,
    brand: brand?.toString(),
    model: model?.toString(),
    year,
    mileage_km,
    price,
    currency,
    images,
    fuel: candidate.fuelType || candidate.fuel,
    gearbox: candidate.transmission,
    power_hp: toInt(candidate.powerHp || candidate.power),
    url: candidate.canonicalUrl || candidate.url,
    seller: candidate.seller ? { name: candidate.seller?.name, type: candidate.seller?.type } : undefined,
  }
}

function extractInventoryFromNext(next: any): InventoryPreview[] {
  // Cherche une liste d’items avec url + name + price
  const arr: any = deepPick(next, ['inventory', 'list', 'results', 'items', 'cars'])
  const list = Array.isArray(arr) ? arr : []
  const out: InventoryPreview[] = []
  for (const it of list) {
    const url = (it?.url || it?.canonicalUrl || '').toString()
    if (!url) continue
    const title = (it?.title || it?.name || '').toString() || undefined
    const price = getNum(it?.price?.amount ?? it?.price)
    const currency = upperOrUndef(it?.price?.currency ?? it?.currency)
    out.push({ url, title, price, currency })
  }
  return out
}

/* ------------------ Fallback dealer inventory ------------------ */
function scrapeDealerInventory(html: string, base?: string): InventoryPreview[] {
  const out: InventoryPreview[] = []
  const linkRe = /href="([^"]+)"/g
  let m: RegExpExecArray | null
  const seen = new Set<string>()
  while ((m = linkRe.exec(html)) !== null) {
    let href = m[1]
    if (href.startsWith('/')) {
      try {
        const u = new URL(base || 'https://www.autoscout24.ch')
        href = `${u.origin}${href}`
      } catch {}
    }
    if (!/^https?:\/\//i.test(href)) continue
    // heuristique: fiches autoscout contiennent "/d/" (detail)
    if (!/autoscout24\.[a-z.]+\/.+\/d\//i.test(href)) continue
    if (seen.has(href)) continue
    seen.add(href)
    out.push({ url: href })
    if (out.length >= 100) break
  }
  return out
}

function guessDealer(html: string, next?: any, ld?: any): { name?: string } | undefined {
  const metaName = (html.match(/<meta property="og:site_name" content="([^"]+)"/)?.[1]) ||
                   (html.match(/<meta property="og:title" content="([^"]+)"/)?.[1]) ||
                   (html.match(/<title>([^<]+)<\/title>/)?.[1])
  const ldOrg = (ld && (ld['@type'] === 'AutoDealer' || ld['@type'] === 'Organization')) ? (ld?.name || ld?.legalName) : undefined
  const nextSeller = next ? deepPick(next, ['seller','dealer','store']) : undefined
  const name = nextSeller?.name || ldOrg || metaName
  return name ? { name } : undefined
}

/* --------- sending: text / image / audio / PTT / reaction ------ */
app.post('/send-text', requireAuth, async (req, res) => {
  try {
    const jid = toJid(req.body.to)
    const text = (req.body.text || '').toString()
    if (!sock) throw new Error('socket not ready')
    await sock.sendMessage(jid, { text })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

app.post('/send-image', requireAuth, async (req, res) => {
  try {
    const jid = toJid(req.body.to)
    const url = (req.body.url || '').toString()
    const caption = (req.body.caption || '').toString()
    if (!sock) throw new Error('socket not ready')
    await sock.sendMessage(jid, { image: { url }, caption })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

app.post('/send-audio', requireAuth, async (req, res) => {
  try {
    const jid = toJid(req.body.to)
    const url = (req.body.url || '').toString()
    if (!sock) throw new Error('socket not ready')
    await sock.sendMessage(jid, { audio: { url }, mimetype: 'audio/mpeg' })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

app.post('/send-ptt', requireAuth, async (req, res) => {
  try {
    const jid = toJid(req.body.to)
    const url = (req.body.url || '').toString()
    if (!sock) throw new Error('socket not ready')
    await sock.sendMessage(jid, { audio: { url }, ptt: true, mimetype: 'audio/ogg' })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

app.post('/react', requireAuth, async (req, res) => {
  try {
    if (!sock) throw new Error('socket not ready')
    const jid = toJid(req.body.jid)
    const id = (req.body.id || '').toString()
    const emoji = (req.body.emoji || '').toString()
    const participant = (req.body.participant || '').toString() || undefined
    const key: WAMessageKey = { id, remoteJid: jid, fromMe: false, participant }
    await sock.sendMessage(jid, { react: { text: emoji, key } })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

/* ---------------------- data listing APIs ---------------------- */
app.get('/contacts', requireAuth, (_req, res) => {
  const contacts = Array.from(contactsMap.values())
  res.json({ count: contacts.length, contacts })
})

app.get('/chats', requireAuth, (_req, res) => {
  const chats = Array.from(chatsMap.values())
  res.json({ count: chats.length, chats })
})

app.get('/messages', requireAuth, async (req, res) => {
  try {
    const jid = toJid((req.query.jid || '').toString())
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 200))
    const arr = (msgMap.get(jid) || []).slice(-limit)
    res.json({ jid, count: arr.length, messages: arr })
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

/* ---------------------------- start ---------------------------- */
const PORT = Number(process.env.PORT || 10000)
app.listen(PORT, () => logger.info(`HTTP server listening on :${PORT}`))
connectWA().catch(err => logger.error(err, 'connectWA failed'))
