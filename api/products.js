// api/products.js — GET /api/products
// Lê o datafeed da Shopee (CSV ou ZIP), aplica filtros durante o parse (early-stop)
// e retorna itens normalizados. Otimizado para feeds grandes (~100k linhas).

import Papa from 'papaparse'
import AdmZip from 'adm-zip'
import crypto from 'crypto'

const CACHE_MS = Number(process.env.CACHE_MS || 120000)        // 2 min de cache do CSV bruto (opcional)
const FEED_ROW_CAP = Number(process.env.FEED_ROW_CAP || 25000) // corta a leitura em 25k linhas no limite
const CANDIDATE_MULTIPLIER = Number(process.env.CANDIDATE_MULTIPLIER || 5)

let CSV_CACHE = { ts: 0, text: null }

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' })

  const { q, category, price_max, min_rating = '0', limit = '20', debug } = req.query
  const want = clampInt(limit, 1, 50)

  try {
    const csvText = await getCSVText() // baixa do feed (ou usa cache)
    const qStr = (q ?? '').toString().toLowerCase()

    const { items: candidates, rowsSeen, aborted } = await parseWithEarlyStop(
      csvText,
      { qStr, category, price_max, min_rating },
      want
    )

    // ordena e corta
    candidates.sort((a, b) => (a.price - b.price) || (b.rating - a.rating) || (b.sold - a.sold))
    let items = candidates.slice(0, want)

    // dedup final por id|url
    const seen = new Set()
    items = items.filter(i => {
      const key = (i.id || '') + '|' + (i.url || '')
      if (seen.has(key)) return false
      seen.add(key); return true
    })

    if (debug === '1') {
      return res.status(200).json({
        debug: { rowsSeen, aborted, collected: candidates.length, returned: items.length }
      })
    }
    return res.status(200).json({ items })
  } catch (e) {
    console.error('[products] ERROR', e)
    return res.status(500).json({ error: 'Erro ao processar feed', detail: String(e?.message || e) })
  }
}

/*** ↓↓↓ Utilitários principais ↓↓↓ ***/

// Baixa e extrai CSV (ZIP ou CSV puro) com cache leve
async function getCSVText() {
  const now = Date.now()
  if (CSV_CACHE.text && now - CSV_CACHE.ts < CACHE_MS) return CSV_CACHE.text

  const url = process.env.SHOPEE_FEED_URL
  if (!url) throw new Error('Falta SHOPEE_FEED_URL')

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    'Accept': 'text/csv,application/zip,application/octet-stream,*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
  }

  const r = await fetch(url, { method: 'GET', headers })
  if (!r.ok) {
    const body = await safeText(r)
    throw new Error(`Feed HTTP ${r.status} ${r.statusText} — body: ${String(body || '').slice(0,200)}`)
  }

  const buf = Buffer.from(await r.arrayBuffer())
  const type = (r.headers.get('content-type') || '').toLowerCase()

  let csvText
  if (type.includes('zip') || isZip(buf)) {
    const zip = new AdmZip(buf)
    const entries = zip.getEntries()
    const entry = entries.find(e => e.entryName.toLowerCase().endsWith('.csv')) || entries[0]
    if (!entry) throw new Error('ZIP sem CSV')
    csvText = entry.getData().toString('utf-8')
  } else {
    csvText = buf.toString('utf-8')
  }

  CSV_CACHE = { ts: Date.now(), text: csvText }
  return csvText
}

// Parse linha-a-linha e para cedo quando já tem candidatos suficientes
async function parseWithEarlyStop(csvText, filters, want) {
  const TARGET = Math.max(1, want) * CANDIDATE_MULTIPLIER
  const candidates = []
  let rowsSeen = 0
  let aborted = false

  await new Promise((resolve, reject) => {
    Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      step: (res, parser) => {
        rowsSeen++
        if (FEED_ROW_CAP && rowsSeen > FEED_ROW_CAP) {
          aborted = true
          parser.abort()
          return
        }

        const row = res.data
        const obj = mapRow(row)
        if (obj && matchesFilters(obj, filters)) {
          candidates.push(obj)
          if (candidates.length >= TARGET) {
            aborted = true
            parser.abort()
          }
        }
      },
      complete: () => resolve(),
      error: (err) => reject(err)
    })
  })

  return { items: candidates, rowsSeen, aborted }
}

// mapeia usando os headers reais do teu feed
function mapRow(row) {
  // Preferir shortlink, se existir; senão, usar o link normal
  const url = pickStr(row['product_short link'], row.product_link, row.product_url, row.url, row.link)
  const title = str(row.title)
  if (!url || !title) return null

  // preço: prioriza sale_price, depois price
  const price = num(row.sale_price ?? row.price ?? row.SalePrice ?? row.Price ?? 0)

  // rating: item_rating (prioriza), depois shop_rating
  const rating = num(row.item_rating ?? row.shop_rating ?? 0)

  // sold: não vi coluna “sold” no teu CSV; uso “like” como sinal fraco (fallback 0)
  const sold = num(row.historical_sold ?? row.sold ?? row.Sold ?? row.like ?? 0)

  // imagem
  const image = pickStr(row.image_link, row.image_link_3, row.image, row.ImageUrl) || null

  // categoria: pega a mais específica que existir
  const category = pickStr(row.global_category3, row.global_category2, row.global_category1, row.Category, row.category) || null

  // id: itemid se vier, senão hash do link
  const id = str(row.itemid) || ('shp_' + md5(url).slice(0, 10))

  return {
    id,
    title,
    price: Number(price || 0),
    currency: 'BRL',
    url,
    image,
    category,
    coupon: null,
    store: 'Shopee',
    available: true,
    rating: Number(rating || 0),
    sold: Number(sold || 0)
  }
}

// filtros aplicados durante o parse
function matchesFilters(obj, { qStr, category, price_max, min_rating }) {
  if (qStr && !(obj.title || '').toLowerCase().includes(qStr)) return false
  if (category && String(obj.category || '').toLowerCase() !== String(category).toLowerCase()) return false
  if (price_max && Number(obj.price) > Number(price_max)) return false
  if (min_rating && Number(obj.rating || 0) < Number(min_rating)) return false
  return true
}

/*** ↓↓↓ helpers ***/
function pickStr(...args){ for (const v of args){ if (typeof v === 'string' && v.trim()) return v.trim() } return null }
function str(v){ return (v == null) ? '' : String(v).trim() }
function num(v){
  if (typeof v === 'number') return v
  if (typeof v === 'string'){
    // trata "12.345,67" e "12345.67"
    const clean = v.replace(/\s/g,'').replace(/\./g,'').replace(',', '.').match(/-?\d+(\.\d+)?/)
    return clean ? Number(clean[0]) : 0
  }
  return 0
}
function md5(s){ return crypto.createHash('md5').update(String(s)).digest('hex') }
function isZip(buf){ return buf.length>4 && buf[0]===0x50 && buf[1]===0x4B && buf[2]===0x03 && buf[3]===0x04 }
async function safeText(r){ try{ return await r.text() } catch{ return null } }
function clampInt(v, min, max){ const n = Number.parseInt(v,10); if (Number.isNaN(n)) return min; return Math.max(min, Math.min(max, n)) }
