// api/products.js — GET /api/products (streaming, low-mem, early-stop)
// Lê CSV ou ZIP diretamente da resposta HTTP, sem carregar tudo em memória.

import { parse } from 'csv-parse'
import unzipper from 'unzipper'
import crypto from 'crypto'

// limites/config via env
const FEED_ROW_CAP = numEnv(process.env.FEED_ROW_CAP, 12000)        // max de linhas a ler (hard cap)
const CANDIDATE_MULTIPLIER = numEnv(process.env.CANDIDATE_MULTIPLIER, 5) // coletar ~limit*5 e parar
const REQ_TIMEOUT_MS = numEnv(process.env.REQ_TIMEOUT_MS, 30000)    // timeout do download

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' })

  const { q, category, price_max, min_rating = '0', limit = '20', debug } = req.query
  const want = clampInt(limit, 1, 50)
  const filters = {
    qStr: (q ?? '').toString().toLowerCase(),
    category: (category ?? '').toString().toLowerCase() || null,
    price_max: price_max ? Number(price_max) : null,
    min_rating: min_rating ? Number(min_rating) : 0
  }

  try {
    const url = process.env.SHOPEE_FEED_URL
    if (!url) return res.status(500).json({ error: 'Falta SHOPEE_FEED_URL' })

    const { stream, contentType } = await fetchFeedStream(url, REQ_TIMEOUT_MS)

    // detecta ZIP x CSV e obtém um stream **só do CSV**
    const csvStream = await toCsvStream(stream, contentType)

    // parse streaming + early-stop
    const { items, rowsSeen, aborted } = await collectCandidates(csvStream, filters, want)

    // ordena e corta
    items.sort((a, b) => (a.price - b.price) || (b.rating - a.rating) || (b.sold - a.sold))
    let out = items.slice(0, want)

    // dedup final por id|url
    const seen = new Set()
    out = out.filter(i => {
      const key = (i.id || '') + '|' + (i.url || '')
      if (seen.has(key)) return false
      seen.add(key); return true
    })

    if (debug === '1') {
      return res.status(200).json({
        debug: { rowsSeen, aborted, collected: items.length, returned: out.length, contentType }
      })
    }
    return res.status(200).json({ items: out })
  } catch (e) {
    console.error('[products] ERROR', e)
    return res.status(500).json({ error: 'Erro ao processar feed', detail: String(e?.message || e) })
  }
}

/* =============== STREAM HELPERS =============== */

async function fetchFeedStream(url, timeoutMs) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort('timeout'), timeoutMs)
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    'Accept': 'text/csv,application/zip,application/octet-stream,*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
  }
  const r = await fetch(url, { method: 'GET', headers, signal: ctrl.signal })
  clearTimeout(t)
  if (!r.ok) {
    const body = await safeText(r)
    throw new Error(`Feed HTTP ${r.status} ${r.statusText} — ${String(body || '').slice(0,200)}`)
  }
  // Em Node 20, r.body é um ReadableStream web. Converte p/ Node stream:
  const nodeStream = ReadableFromWeb(r.body)
  const contentType = (r.headers.get('content-type') || '').toLowerCase()
  return { stream: nodeStream, contentType }
}

// se for ZIP, extrai a 1ª .csv **via stream**; senão, retorna o próprio stream
async function toCsvStream(stream, contentType) {
  if (contentType.includes('zip')) {
    // acha a primeira entry .csv sem descompactar tudo na memória
    const dir = stream.pipe(unzipper.Parse({ forceStream: true }))
    for await (const entry of dir) {
      const name = entry.path.toLowerCase()
      if (name.endsWith('.csv')) {
        return entry // entry já é um stream do CSV
      }
      entry.autodrain()
    }
    throw new Error('ZIP sem CSV')
  }
  return stream // CSV puro
}

// coleta candidatos durante o parse e PARA cedo
async function collectCandidates(csvStream, filters, want) {
  const TARGET = Math.max(1, want) * CANDIDATE_MULTIPLIER
  const items = []
  let rowsSeen = 0
  let aborted = false

  // csv-parse em streaming
  const parser = csvStream.pipe(parse({
    columns: true,         // usa headers do CSV
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true
  }))

  for await (const row of parser) {
    rowsSeen++
    const obj = mapRow(row)
    if (obj && matchesFilters(obj, filters)) {
      items.push(obj)
      if (items.length >= TARGET) { aborted = true; break }
    }
    if (FEED_ROW_CAP && rowsSeen >= FEED_ROW_CAP) { aborted = true; break }
  }

  // interrompe o stream no fim/early-stop
  if (parser.destroy) parser.destroy()
  if (csvStream.destroy) csvStream.destroy()

  return { items, rowsSeen, aborted }
}

/* =============== MAP & FILTERS (ajustado ao teu CSV) =============== */

function mapRow(row) {
  // preferir short link (tem feed que chama "product_short link" com espaço!)
  const url = pickStr(row['product_short link'], row.product_short_link, row.product_link, row.product_url, row.url, row.link)
  const title = str(row.title)
  if (!url || !title) return null

  const price = num(row.sale_price ?? row.price ?? row.SalePrice ?? row.Price ?? 0)
  const rating = num(row.item_rating ?? row.shop_rating ?? 0)
  const sold = num(row.historical_sold ?? row.sold ?? row.Sold ?? row.like ?? 0)
  const image = pickStr(row.image_link, row.image_link_3, row.image, row.ImageUrl) || null
  const category = pickStr(row.global_category3, row.global_category2, row.global_category1, row.Category, row.category) || null
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

function matchesFilters(obj, { qStr, category, price_max, min_rating }) {
  if (qStr && !(obj.title || '').toLowerCase().includes(qStr)) return false
  if (category && String(obj.category || '').toLowerCase() !== category) return false
  if (price_max != null && Number(obj.price) > Number(price_max)) return false
  if (min_rating != null && Number(obj.rating || 0) < Number(min_rating)) return false
  return true
}

/* =============== utils =============== */
function md5(s){ return crypto.createHash('md5').update(String(s)).digest('hex') }
function pickStr(...args){ for (const v of args){ if (typeof v === 'string' && v.trim()) return v.trim() } return null }
function str(v){ return (v == null) ? '' : String(v).trim() }
function num(v){
  if (typeof v === 'number') return v
  if (typeof v === 'string'){
    const clean = v.replace(/\s/g,'').replace(/\./g,'').replace(',', '.').match(/-?\d+(\.\d+)?/)
    return clean ? Number(clean[0]) : 0
  }
  return 0
}
function clampInt(v, min, max){ const n = Number.parseInt(v,10); if (Number.isNaN(n)) return min; return Math.max(min, Math.min(max, n)) }
async function safeText(r){ try{ return await r.text() } catch{ return null } }

// converte ReadableStream (web) → Node stream (compatível com unzipper/csv-parse)
import { Readable } from 'node:stream'
function ReadableFromWeb(webStream) {
  // se já for Node stream, retorna direto
  if (typeof webStream?.pipe === 'function') return webStream
  return Readable.from(webStream) // Node 18+ converte WebStream para Readable
}
function numEnv(v, def){ const n = Number(v); return Number.isFinite(n) ? n : def }

