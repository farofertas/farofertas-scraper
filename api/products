// api/products.js — Shopee Datafeed → JSON normalizado com filtros (GET)
// Query: q, category, price_max, min_rating (0–5), limit (1–50)

import Papa from 'papaparse'
import AdmZip from 'adm-zip'
import crypto from 'crypto'

let CACHE = { ts: 0, items: [] }
const CACHE_MS = Number(process.env.CACHE_MS || 60000)

export default async function handler(req, res) {
  // CORS básico
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' })

  const { q, category, price_max, min_rating = '0', limit = '20' } = req.query

  try {
    const now = Date.now()
    if (!CACHE.items.length || now - CACHE.ts > CACHE_MS) {
      const csvText = await downloadAndExtractCSV(process.env.SHOPEE_FEED_URL)
      const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true })
      let items = (parsed.data || []).map(mapShopeeRow).filter(Boolean)
      CACHE = { ts: now, items }
    }

    let items = [...CACHE.items]

    const qStr = (q ?? '').toString().toLowerCase()
    if (qStr) items = items.filter(i => (i.title || '').toLowerCase().includes(qStr))
    if (category) items = items.filter(i => (i.category || '').toLowerCase() === String(category).toLowerCase())
    if (price_max) items = items.filter(i => Number(i.price) <= Number(price_max))
    if (min_rating) items = items.filter(i => Number(i.rating ?? 0) >= Number(min_rating))

    // ordenação: menor preço → maior rating → mais vendidos
    items.sort((a, b) => (a.price - b.price) || (b.rating - a.rating) || (b.sold - a.sold))

    // dedup por id|url
    const seen = new Set()
    items = items.filter(i => {
      const key = i.id + '|' + i.url
      if (seen.has(key)) return false
      seen.add(key); return true
    })

    const out = items.slice(0, Math.min(Math.max(Number(limit) || 20, 1), 50))
    return res.status(200).json({ items: out })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: 'Erro ao processar feed' })
  }
}

async function downloadAndExtractCSV(feedUrl) {
  if (!feedUrl) throw new Error('Falta SHOPEE_FEED_URL')
  const r = await fetch(feedUrl, { method: 'GET' })
  if (!r.ok) throw new Error('Falha ao baixar feed ' + r.status)
  const buf = Buffer.from(await r.arrayBuffer())
  const type = r.headers.get('content-type') || ''
  if (type.includes('zip') || isZip(buf)) {
    const zip = new AdmZip(buf)
    const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.csv')) || zip.getEntries()[0]
    if (!entry) throw new Error('ZIP sem CSV')
    return entry.getData().toString('utf-8')
  }
  return buf.toString('utf-8')
}

function isZip(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04
}

function mapShopeeRow(row) {
  const title = (row.title || row.name || row.ProductName || '').toString().trim()
  const url   = (row.product_url || row.url || row.link || row.ProductUrl || '').toString().trim()
  if (!title || !url) return null

  const price   = firstNumber(row.final_price ?? row.price ?? row.SalePrice ?? row.Price ?? 0)
  const rating  = firstNumber(row.rating ?? row.avg_rating ?? row.Rating ?? 0)
  const sold    = firstNumber(row.historical_sold ?? row.sold ?? row.Sold ?? 0)
  const image   = (row.image_url || row.image || row.ImageUrl || '').toString() || null
  const category= (row.category || row.Category || '').toString() || null
  const coupon  = (row.coupon || row.coupon_code || row.Coupon || '').toString() || null
  const currency= (row.currency || row.Currency || 'BRL').toString()

  return {
    id: String(row.id || row.itemid || row.sku || hash(url)),
    title,
    price: Number(price || 0),
    currency,
    url,               // preserve exatamente (shortlink/afiliado)
    image: image || null,
    category,
    coupon: coupon || null,
    store: 'Shopee',
    available: true,
    rating: Number(rating || 0),
    sold: Number(sold || 0)
  }
}

function firstNumber(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const m = v.replace(',', '.').match(/-?\d+(\.\d+)?/)
    return m ? Number(m[0]) : 0
  }
  return 0
}

function hash(s) {
  return 'shp_' + crypto.createHash('md5').update(s).digest('hex').slice(0, 10)
}
