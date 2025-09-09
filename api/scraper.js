// api/scraper.js — fetch-only COM fallbacks extra para título da Shopee.
// Fluxo:
// 1) Segue shortlink (redirect: 'follow') → finalUrl + HTML.
// 2) Se for Shopee: extrai shopid/itemid (inclui /opaanlp/{shopid}/{itemid}).
// 3) Tenta nome/preço via API pública (v4 desktop/mobile; v2 desktop/mobile).
// 4) Se APIs falharem: busca título na canônica https://shopee.com.br/i.{shopid}.{itemid} (desktop→mobile).
// 5) Se ainda falhar: pega de JSON-LD do HTML; se não tiver, varre scripts perto do itemid por `"name":"..."`.
// 6) Último fallback: <title>/og:title; depois slug; por fim "Produto Shopee".
// 7) Template SEMPRE usa o link original enviado (teu shortlink).

const UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36";
const UA_MOBILE  = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const HTML_HEADERS_DESKTOP = {
  "User-Agent": UA_DESKTOP,
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Upgrade-Insecure-Requests": "1"
};
const HTML_HEADERS_MOBILE = {
  "User-Agent": UA_MOBILE,
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Upgrade-Insecure-Requests": "1"
};
const JSON_HEADERS_DESKTOP = {
  "User-Agent": UA_DESKTOP,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
};
const JSON_HEADERS_MOBILE = {
  "User-Agent": UA_MOBILE,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
};

const isShopeeHost = (h) =>
  /(^|\.)shopee\./i.test(h) || /(^|\.)s\.shopee\.com\.br$/i.test(h) || /(^|\.)shope\.ee$/i.test(h);

function sanitizeTitle(t) {
  if (!t) return null;
  let s = String(t).trim();
  s = s.replace(/\s{2,}/g, " ");
  // evita título só numérico ou no formato "i.shopid.itemid"
  if (/^\d{6,}$/.test(s)) return null;
  if (/^i\.\d+\.\d+$/i.test(s)) return null;
  // corta lixo comum
  s = s.replace(/\s*\|\s*Shopee\s*Brasil?$/i, "");
  return s || null;
}

const parseTitleFromHTML = (html) =>
  html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]?.trim() ||
  html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ||
  null;

function formatBRL(v) {
  try { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v); }
  catch { return `R$ ${Number(v).toFixed(2).replace(".", ",")}`; }
}

function buildTemplates(title, price, affiliateUrl, isShopee) {
  const safeTitle = title || (isShopee ? "Produto Shopee" : "Página");
  const hasPrice = typeof price === "number" && Number.isFinite(price);
  const line = hasPrice
    ? `${safeTitle} por ${formatBRL(price)} ➜ ${affiliateUrl}`
    : `${safeTitle} ➜ ${affiliateUrl}`;
  const caption = hasPrice
    ? `🔥 ${safeTitle}\npor ${formatBRL(price)}\n${affiliateUrl}`
    : `🔥 ${safeTitle}\n${affiliateUrl}`;
  return { template_line: line, template_caption: caption };
}

// --- redirect ---
async function resolveFinal(urlStr) {
  try {
    const r = await fetch(urlStr, { method: "GET", redirect: "follow", headers: HTML_HEADERS_DESKTOP });
    const finalUrl = r.url || urlStr;
    const html = await r.text().catch(() => "");
    return { finalUrl, html };
  } catch {
    return { finalUrl: urlStr, html: "" };
  }
}

// --- IDs Shopee ---
function parseShopeeIdsFromUrl(urlStr) {
  try {
    const p = new URL(urlStr).pathname;

    let m = p.match(/(?:-|\/)i\.([0-9]+)\.([0-9]+)/i);
    if (m) return { shopid: m[1], itemid: m[2] };

    m = p.match(/\/product\/([0-9]+)\/([0-9]+)/i);
    if (m) return { shopid: m[1], itemid: m[2] };

    m = p.match(/\/(?:opaanlp|affiliate|applink|nlp|out|outlink)\/([0-9]+)\/([0-9]+)(?:[\/\?#]|$)/i);
    if (m) return { shopid: m[1], itemid: m[2] };

    const segs = p.split("/").filter(Boolean);
    for (let i = 0; i < segs.length - 1; i++) {
      if (/^\d+$/.test(segs[i]) && /^\d+$/.test(segs[i + 1])) return { shopid: segs[i], itemid: segs[i + 1] };
    }

    return null;
  } catch { return null; }
}

// --- título por slug ---
function titleFromSlug(urlStr) {
  try {
    const u = new URL(urlStr);
    let m = u.pathname.match(/\/([^\/]+)-i\.\d+\.\d+(?:$|\?)/i);
    if (m?.[1]) return decodeURIComponent(m[1]).replace(/[-_]+/g, " ").trim();
    m = u.pathname.match(/\/([^\/]+)\/product\/\d+\/\d+(?:$|\?)/i);
    if (m?.[1]) return decodeURIComponent(m[1]).replace(/[-_]+/g, " ").trim();
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length) return decodeURIComponent(segs[segs.length - 1]).replace(/[-_]+/g, " ").trim();
    return null;
  } catch { return null; }
}

// --- JSON-LD no HTML ---
function parseJSONLD(html) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let out = { title: null, price: null };
  for (const m of scripts) {
    try {
      const raw = (m[1] || "").trim();
      if (!raw) continue;
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        if (!out.title && (item?.name || item?.headline)) out.title = sanitizeTitle(item.name || item.headline);
        const offers = item?.offers ? (Array.isArray(item.offers) ? item.offers : [item.offers]) : [];
        for (const off of offers) {
          const v = off?.price ?? off?.lowPrice ?? off?.highPrice;
          if (out.price == null && v != null) {
            const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", "."));
            if (Number.isFinite(n)) out.price = n;
          }
        }
      }
    } catch {}
  }
  return out;
}

// --- varredura por "name":"..." perto do itemid ---
function extractNameNearItemId(html, itemid) {
  if (!html || !itemid) return null;
  const needle = String(itemid);
  const idx = html.indexOf(needle);
  if (idx === -1) return null;
  // pega uma janela de ~50k chars ao redor (para achar o blob JSON)
  const start = Math.max(0, idx - 25000);
  const end   = Math.min(html.length, idx + 25000);
  const slice = html.slice(start, end);
  // várias formas de "name": "...", incluindo com espaços
  const m = slice.match(/"name"\s*:\s*"([^"]{3,200})"/i);
  if (m && m[1]) {
    const raw = m[1].replace(/\\"/g, '"');
    return sanitizeTitle(raw);
  }
  return null;
}

// --- APIs públicas da Shopee ---
async function tryShopeeAPIv4(shopid, itemid, referer, useMobileUA = false) {
  const headers = useMobileUA ? JSON_HEADERS_MOBILE : JSON_HEADERS_DESKTOP;
  const url = `https://shopee.com.br/api/v4/item/get?itemid=${itemid}&shopid=${shopid}`;
  const r = await fetch(url, { headers: { ...headers, Referer: referer } });
  if (!r.ok) throw new Error(`v4 ${r.status}`);
  const j = await r.json();
  const d = j?.data;
  if (!d) throw new Error("v4 sem data");
  const price = typeof d.price === "number" ? d.price / 100000 : null;
  const title = d.name || null;
  return { title, price };
}
async function tryShopeeAPIv2(shopid, itemid, referer, useMobileUA = false) {
  const headers = useMobileUA ? JSON_HEADERS_MOBILE : JSON_HEADERS_DESKTOP;
  const url = `https://shopee.com.br/api/v2/item/get?itemid=${itemid}&shopid=${shopid}`;
  const r = await fetch(url, { headers: { ...headers, Referer: referer } });
  if (!r.ok) throw new Error(`v2 ${r.status}`);
  const j = await r.json();
  const d = j?.item;
  if (!d) throw new Error("v2 sem item");
  const price = typeof d.price === "number" ? d.price / 100000 : null;
  const title = d.name || null;
  return { title, price };
}

// --- título da canônica i.{shopid}.{itemid} ---
async function fetchTitleFromCanonical(shopid, itemid) {
  const canonical = `https://shopee.com.br/i.${shopid}.${itemid}`;
  // desktop
  try {
    const r = await fetch(canonical, { headers: HTML_HEADERS_DESKTOP });
    const html = await r.text();
    const t = sanitizeTitle(parseTitleFromHTML(html));
    if (t) return { title: t, canonical, html };
    // tenta JSON-LD e varredura
    const fromLd = parseJSONLD(html);
    if (fromLd.title) return { title: fromLd.title, canonical, html };
    const near = extractNameNearItemId(html, itemid);
    if (near) return { title: near, canonical, html };
  } catch {}
  // mobile
  try {
    const r2 = await fetch(canonical, { headers: HTML_HEADERS_MOBILE });
    const html2 = await r2.text();
    const t2 = sanitizeTitle(parseTitleFromHTML(html2));
    if (t2) return { title: t2, canonical, html: html2 };
    const fromLd2 = parseJSONLD(html2);
    if (fromLd2.title) return { title: fromLd2.title, canonical, html: html2 };
    const near2 = extractNameNearItemId(html2, itemid);
    if (near2) return { title: near2, canonical, html: html2 };
  } catch {}
  // slug
  return { title: sanitizeTitle(titleFromSlug(canonical)) || null, canonical, html: "" };
}

async function resolveShopeeNamePrice(shopid, itemid, finalUrl, finalHtml) {
  const referer = `https://shopee.com.br/i.${shopid}.${itemid}`;

  // 1) APIs
  try { return await tryShopeeAPIv4(shopid, itemid, referer, false); } catch {}
  try { return await tryShopeeAPIv4(shopid, itemid, referer, true); } catch {}
  try { return await tryShopeeAPIv2(shopid, itemid, referer, false); } catch {}
  try { return await tryShopeeAPIv2(shopid, itemid, referer, true); } catch {}

  // 2) Canônica (com JSON-LD/varredura)
  try {
    const got = await fetchTitleFromCanonical(shopid, itemid);
    if (got.title) return { title: got.title, price: null };
  } catch {}

  // 3) Ainda na final: JSON-LD e varredura local
  const fromLd = parseJSONLD(finalHtml || "");
  if (fromLd.title) return { title: fromLd.title, price: fromLd.price ?? null };
  const near = extractNameNearItemId(finalHtml || "", itemid);
  if (near) return { title: near, price: null };

  return { title: null, price: null };
}

// --- handler ---
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Use POST" });

  const { url } = req.body || {};
  if (!url || typeof url !== "string") return res.status(400).json({ success: false, error: "missing url" });

  let original;
  try { original = new URL(url); } catch { return res.status(400).json({ success: false, error: "invalid url" }); }

  const affiliate_url = url; // SEMPRE o link original no template

  try {
    const { finalUrl, html } = await resolveFinal(original.toString());
    const finalHost = (() => { try { return new URL(finalUrl).hostname; } catch { return original.hostname; } })();
    const isShopee = isShopeeHost(finalHost);

    let title = null;
    let price = null;

    if (isShopee) {
      const ids = parseShopeeIdsFromUrl(finalUrl);
      if (ids) {
        const got = await resolveShopeeNamePrice(ids.shopid, ids.itemid, finalUrl, html);
        title =
          sanitizeTitle(got.title) ||
          sanitizeTitle(parseTitleFromHTML(html)) ||
          sanitizeTitle(titleFromSlug(finalUrl)) ||
          null;
        price = typeof got.price === "number" ? got.price : null;
      } else {
        // sem IDs — tenta HTML/slug direto
        const fromLd = parseJSONLD(html || "");
        title =
          sanitizeTitle(fromLd.title) ||
          sanitizeTitle(parseTitleFromHTML(html)) ||
          sanitizeTitle(titleFromSlug(finalUrl)) ||
          null;
      }
      if (!title) title = "Produto Shopee";
    } else {
      // não Shopee
      const fromLd = parseJSONLD(html || "");
      title =
        sanitizeTitle(fromLd.title) ||
        sanitizeTitle(parseTitleFromHTML(html)) ||
        sanitizeTitle(titleFromSlug(finalUrl)) ||
        "Página";
      price = typeof fromLd.price === "number" ? fromLd.price : null;
    }

    const { template_line, template_caption } = buildTemplates(title, price, affiliate_url, isShopee);

    return res.status(200).json({
      success: true,
      domain: finalHost,
      title,
      price,
      currency: "BRL",
      image: null,
      availability: null,
      affiliate_url,              // preserva teu shortlink
      template_line,
      template_caption,
      debug_url_final: finalUrl   // útil pra diagnóstico
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
}


