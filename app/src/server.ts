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

/* --------------------------- security -------------------------- */
// Accept either RESOLVER_BEARER (for Lovable) or AUTH_TOKEN (manual/testing)
const AUTH_TOKEN =
  process.env.RESOLVER_BEARER ||
  process.env.AUTH_TOKEN ||
  'MY_PRIVATE_FURIA_API_KEY_2025'

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const hdr = (req.headers['authorization'] || '').toString()
  const got = hdr.startsWith('Bearer ') ? hdr.slice(7) : ''
  if (!got || got !== AUTH_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
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

/* ----------------------- SMART FETCH (anti-bot) ----------------- */
const SCRAPER_PROVIDER = process.env.SCRAPER_PROVIDER || ''       // e.g. "scraperapi" | "scrapingbee"
const SCRAPER_API_KEY  = process.env.SCRAPER_API_KEY  || ''
const SCRAPER_COUNTRY  = process.env.SCRAPER_COUNTRY  || 'ch'

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

function blockedHtml(html: string) {
  const s = html.slice(0, 4096).toLowerCase()
  return (
    s.includes("access denied") ||
    s.includes("request forbidden") ||
    s.includes("/captcha") ||
    s.includes("bot detected") ||
    s.includes("verification required")
  )
}

async function fetchDirect(url: string) {
  const r = await fetch(url, {
    headers: {
      "user-agent": DESKTOP_UA,
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "fr-CH,fr;q=0.9,de-CH;q=0.8,en;q=0.7",
      "upgrade-insecure-requests": "1",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
    },
  } as any)
  const text = await (r as any).text()
  return { ok: (r as any).ok, status: (r as any).status, text }
}

async function fetchViaScraper(url: string) {
  if (!SCRAPER_PROVIDER || !SCRAPER_API_KEY) {
    return { ok: false, status: 500, text: "scraper_not_configured" }
  }

  // ScraperAPI — renvoie du HTML brut
  if (SCRAPER_PROVIDER.toLowerCase() === "scraperapi") {
    const api = new URL("https://api.scraperapi.com/")
    api.searchParams.set("api_key", SCRAPER_API_KEY)
    api.searchParams.set("url", url)
    if (SCRAPER_COUNTRY) api.searchParams.set("country_code", SCRAPER_COUNTRY)

    const r = await fetch(api.toString(), { headers: { "Accept": "text/html" } } as any)
    const text = await (r as any).text()
    return { ok: (r as any).ok, status: (r as any).status, text }
  }

  // ScrapingBee — alternative
  if (SCRAPER_PROVIDER.toLowerCase() === "scrapingbee") {
    const api = new URL("https://app.scrapingbee.com/api/v1/")
    api.searchParams.set("api_key", SCRAPER_API_KEY)
    api.searchParams.set("url", url)
    api.searchParams.set("render_js", "false")
    if (SCRAPER_COUNTRY) api.searchParams.set("country_code", SCRAPER_COUNTRY)
    api.searchParams.set("block_ads", "true")

    const r = await fetch(api.toString() as any)
    const text = await (r as any).text()
    return { ok: (r as any).ok, status: (r as any).status, text }
  }

  return { ok: false, status: 500, text: "unknown_scraper_provider" }
}

async function smartGetHtml(url: string) {
  // 1) tentative directe
  try {
    const d = await fetchDirect(url)
    if (d.ok && !blockedHtml(d.text)) return d.text
    if (![403, 429, 503].includes(d.status) && !blockedHtml(d.text)) {
      // Si ce n'est pas explicitement bloqué mais pas 200 → tentative proxy quand même
    }
  } catch { /* ignore */ }

  // 2) fallback via proxy
  const p = await fetchViaScraper(url)
  if (p.ok && !blockedHtml(p.text)) return p.text

  const err = new Error("fetch_failed_403") as any
  err.status = p.status || 502
  throw err
}

/* ----------------------- Cars normalisation --------------------- */
type Car = {
  title?: string
  brand?: string
  model?: string
  version?: string
  price?: number
  currency?: string
  mileage?: number
  firstRegistration?: string
  fuel?: string
  gearbox?: string
  powerHp?: number
  color?: string
  images?: string[]
  url?: string
  vin?: string
}

function safeJsonParse<T = any>(s: string): T | null {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function traverse(obj: any, fn: (node: any) => void) {
  const stack = [obj]
  const seen = new Set<any>()
  while (stack.length) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue
    seen.add(cur)
    fn(cur)
    if (Array.isArray(cur)) {
      for (const it of cur) stack.push(it)
    } else {
      for (const k of Object.keys(cur)) stack.push((cur as any)[k])
    }
  }
}

function getNum(n: any): number | undefined {
  if (n == null) return undefined
  const x = Number(String(n).replace(/[^\d.]/g, ''))
  return Number.isFinite(x) ? x : undefined
}

function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Partial<T> {
  const out: any = {}
  for (const k of keys) if ((o as any)[k] != null) out[k] = (o as any)[k]
  return out
}

/* -------------------- Parsers: NEXT / LD+JSON ------------------- */
function extractCarFromNext(next: any): Car {
  // Stratégie générique: parcourir l’objet Next et scorer les nœuds qui ressemblent à une "fiche véhicule"
  let best: any = null
  let bestScore = -1

  traverse(next, (node) => {
    if (!node || typeof node !== 'object') return
    let score = 0
    const keys = Object.keys(node)

    const has = (k: string) => keys.includes(k)

    // indices de véhicule fréquents
    if (has('make') || has('brand')) score += 2
    if (has('model')) score += 2
    if (has('price') || has('grossPrice') || has('netPrice') || has('offers')) score += 2
    if (has('mileage') || has('mileageFromOdometer')) score += 2
    if (has('firstRegistration') || has('firstRegistrationDate') || has('firstRegYear')) score += 1
    if (has('fuelType') || has('fuel')) score += 1
    if (has('gearbox') || has('vehicleTransmission')) score += 1
    if (has('power') || has('powerHp') || has('kw') || has('hp')) score += 1
    if (has('images') || has('image')) score += 1

    if (score > bestScore) { bestScore = score; best = node }
  })

  const c: Car = {}

  if (best) {
    const brand = (best.brand?.name || best.brand || best.make || '').toString() || undefined
    const model = (best.model?.name || best.model || '').toString() || undefined
    const version = (best.version || best.trim || best.equipmentVariant || '').toString() || undefined

    let price = getNum(best.price ?? best.grossPrice ?? best.netPrice ?? best?.offers?.price)
    const currency =
      (best.currency || best.priceCurrency || best?.offers?.priceCurrency || '').toString().toUpperCase() || undefined

    let mileage =
      getNum(best.mileage ?? best.mileageFromOdometer?.value ?? best.odometer ?? best.kilometers ?? best.km)

    const firstRegistration =
      (best.firstRegistrationDate || best.firstRegistration || best.registrationDate || best.firstRegYear || undefined)?.toString()

    const fuel = (best.fuelType || best.fuel || best.fueltype || '').toString() || undefined
    const gearbox = (best.vehicleTransmission || best.gearbox || '').toString() || undefined
    const powerHp =
      getNum(best.powerHp ?? best.hp ?? (best.power && /(\d+)\s*hp/i.test(String(best.power)) ? RegExp.$1 : undefined))

    const color = (best.color || best.exteriorColor || '').toString() || undefined

    let images: string[] | undefined
    if (Array.isArray(best.images)) images = best.images.map(String)
    else if (Array.isArray(best.image)) images = best.image.map(String)
    else if (typeof best.image === 'string') images = [best.image]

    Object.assign(c, { brand, model, version, price, currency, mileage, firstRegistration, fuel, gearbox, powerHp, color, images })
  }

  return c
}

function mapLdToCar(ldRoot: any): Car {
  // ldRoot peut être un array, ItemList, Vehicle, Product, etc.
  let ld: any = ldRoot
  if (Array.isArray(ldRoot)) {
    // prendre le premier Vehicle ou Product qui contient un "offers"
    ld = ldRoot.find((x) => x?.['@type'] === 'Vehicle' || x?.['@type'] === 'Product') || ldRoot[0]
  }

  if (!ld || typeof ld !== 'object') return {}

  // Si c'est un ItemList -> pas une fiche, on renverra vide (géré ailleurs)
  if (ld['@type'] === 'ItemList') return {}

  const brand = (ld.brand?.name || ld.brand || '').toString() || undefined
  const model = (ld.model || ld.modelDate || '').toString() || undefined
  const version = (ld.name || ld.vehicleModelDate || '').toString() || undefined

  const offers = ld.offers || {}
  const price = getNum(offers.price)
  const currency = (offers.priceCurrency || '').toString().toUpperCase() || undefined

  const mileage = getNum(ld.mileageFromOdometer?.value ?? ld.mileage)
  const firstRegistration = (ld.productionDate || ld.dateVehicleFirstRegistered || ld.releaseDate || undefined)?.toString()
  const fuel = (ld.fuelType || '').toString() || undefined
  const gearbox = (ld.vehicleTransmission || '').toString() || undefined
  const powerHp = getNum(ld?.vehicleEngine?.enginePower?.value ?? ld?.vehicleEngine?.horsepower)
  const color = (ld.color || '').toString() || undefined
  const url = (ld.url || '').toString() || undefined
  const vin = (ld.vehicleIdentificationNumber || ld.vin || '').toString() || undefined

  let images: string[] | undefined
  if (Array.isArray(ld.image)) images = ld.image.map(String)
  else if (typeof ld.image === 'string') images = [ld.image]

  return { brand, model, version, price, currency, mileage, firstRegistration, fuel, gearbox, powerHp, color, images, url, vin }
}

/* ----------------- Dealer inventory (garage page) --------------- */
type InventoryPreview = { url: string; title?: string; price?: number; currency?: string }

function scrapeAllLdJson(html: string): any[] {
  const out: any[] = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const raw = m[1]?.trim()
    if (!raw) continue
    const node = safeJsonParse<any>(raw)
    if (node) out.push(node)
  }
  return out
}

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
    const currency = (item?.offers?.priceCurrency ?? el?.offers?.priceCurrency || '').toString().toUpperCase() || undefined
    items.push({ url, title, price, currency })
  }
  return items
}

function scrapeDealerInventory(html: string): InventoryPreview[] {
  const out: InventoryPreview[] = []

  // 1) via JSON-LD: ItemList
  const lds = scrapeAllLdJson(html)
  for (const ld of lds) {
    if (ld?.['@type'] === 'ItemList') {
      out.push(...fromItemList(ld))
    }
    if (Array.isArray(ld)) {
      for (const sub of ld) {
        if (sub?.['@type'] === 'ItemList') out.push(...fromItemList(sub))
      }
    }
  }

  // 2) fallback: liens /fr/d/... dans le HTML
  const hrefRe = /href=["'](https?:\/\/www\.autoscout24\.ch\/[^"']*\/d\/[^"']+)["']/gi
  const set = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = hrefRe.exec(html))) {
    const u = m[1]
    if (!set.has(u)) {
      set.add(u)
      out.push({ url: u })
    }
  }

  // 3) dédupe
  const dedup = new Map<string, InventoryPreview>()
  for (const it of out) {
    const key = it.url
    if (!dedup.has(key)) dedup.set(key, it)
  }
  return Array.from(dedup.values())
}

function guessDealer(html: string) {
  // Cherche un JSON-LD Organization/AutoDealer
  const lds = scrapeAllLdJson(html)
  for (const ld of lds) {
    const arr = Array.isArray(ld) ? ld : [ld]
    for (const node of arr) {
      const t = (node?.['@type'] || '').toString().toLowerCase()
      if (t.includes('autodealer') || t.includes('organization')) {
        const name = (node.name || '').toString() || undefined
        const telephone = (node.telephone || '').toString() || undefined
        const url = (node.url || '').toString() || undefined
        const address = node.address ? pick(node.address, ['streetAddress','postalCode','addressLocality','addressRegion','addressCountry'] as any) : undefined
        if (name || telephone || url) return { name, telephone, url, address }
      }
    }
  }

  // fallback meta og:site_name
  const og = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i.exec(html)
  if (og?.[1]) return { name: og[1] }

  // fallback titre <title>
  const t = /<title[^>]*>([^<]+)<\/title>/i.exec(html)
  if (t?.[1]) return { name: t[1] }

  return {}
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
const RESOLVER_BEARER = process.env.RESOLVER_BEARER || ''

function requireResolverAuth(req: Request, res: Response, next: NextFunction) {
  const h = String(req.headers.authorization || '')
  const t = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (!RESOLVER_BEARER) return res.status(500).json({ ok:false, error:'resolver bearer not set' })
  if (t !== RESOLVER_BEARER) return res.status(401).json({ ok:false, error:'unauthorized' })
  next()
}

// Santé
app.get('/cars/health', (_req, res) => {
  res.json({ ok: true, service: 'cars-resolver', ts: Date.now() })
})

app.post('/cars/connect', requireResolverAuth, async (req, res) => {
  try {
    const link = String(req.body?.link || '').trim()
    if (!link) return res.status(400).json({ ok:false, error:'link required' })

    // Fetch HTML avec anti-bot
    const html = await smartGetHtml(link)

    // 1) Tenter __NEXT_DATA__
    const mNext = html.match(/<script id="__NEXT_DATA__"[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/)
    if (mNext) {
      const next = safeJsonParse<any>(mNext[1])
      if (next) {
        const carFromNext = extractCarFromNext(next)
        const valid = Object.keys(carFromNext).length > 0
        if (valid) {
          return res.json({ ok:true, kind:'listing', source:'next', car: carFromNext })
        }
      }
    }

    // 2) JSON-LD (Vehicle / Product)
    const ldNodes = scrapeAllLdJson(html)
    for (const node of ldNodes) {
      const arr = Array.isArray(node) ? node : [node]
      for (const ld of arr) {
        const t = (ld?.['@type'] || '').toString().toLowerCase()
        if (t === 'vehicle' || t === 'product') {
          const car = mapLdToCar(ld)
          const valid = car.brand || car.model || car.price
          if (valid) return res.json({ ok:true, kind:'listing', source:'ld+json', car })
        }
      }
    }

    // 3) Garage: liste d’inventaire
    const inventory = scrapeDealerInventory(html)
    if (inventory?.length) {
      return res.json({
        ok:true,
        kind:'garage',
        dealer: guessDealer(html),
        inventory_preview: inventory.slice(0, 10)
      })
    }

    return res.status(422).json({ ok:false, error:'unrecognized_autoscout24_page' })
  } catch (e:any) {
    const status = e?.status || 500
    const code   = status === 403 ? 'blocked_by_anti_bot' : 'resolver_crash'
    return res.status(status === 403 ? 502 : status).json({
      ok:false, error: code, details: e?.message || String(e)
    })
  }
})

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
