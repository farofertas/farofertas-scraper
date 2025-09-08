// api/scraper.js
// Fetch-only (sem headless). Suporte completo a shortlinks da Shopee, preservando o link afiliado original.
// Retorna também `template_line` e `template_caption` prontos.

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const HEADERS_HTML = {
  "User-Agent": UA_CHROME,
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Upgrade-Insecure-Requests": "1"
};
const HEADERS_JSON = {
  "User-Agent": UA_CHROME,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
};

// ---------- helpers ----------
const sanitizeNumber = (txt) => {
  if (!txt) return null;
  const only = txt.replace(/\s/g, "").replace(/[^\d,.-]/g, "");
  const normalized = only.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
};
const extractBetween = (html, re) => {
  const m = html.match(re);
  return m ? m[1].trim() : null;
};
const parseTitle = (html) =>
  extractBetween(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
  extractBetween(html, /<title[^>]*>([^<]+)<\/title>/i) || null;
const parseOgImage = (html) =>
  extractBetween(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
const parseMetaPrice = (html) => {
  const itemprop = extractBetween(html, /<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (itemprop) return sanitizeNumber(itemprop);
  const productAmount = extractBetween(html, /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (productAmount) return sanitizeNumber(productAmount);
  const twitterData1 = extractBetween(html, /<meta[^>]+name=["']twitter:data1["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (twitterData1) return sanitizeNumber(twitterData1);
  const br = extractBetween(html, /R\$\s*([\d\.\,]+)/i);
  if (br) return sanitizeNumber(br);
  return null;
};
const parseMetaCurrency = (html) => {
  const itemprop = extractBetween(html, /<meta[^>]+itemprop=["']priceCurrency["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (itemprop) return itemprop.toUpperCase();
  const productCurrency = extractBetween(html, /<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (productCurrency) return productCurrency.toUpperCase();
  return "BRL";
};
function parseJSONLD(html) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const out = { title: null, price: null, currency: "BRL", image: null, availability: null };
  for (const m of scripts) {
    try {
      const raw = (m[1] || "").trim();
      if (!raw) continue;
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        if (!out.title && (item?.name || item?.headline)) out.title = item.name || item.headline;
        if (!out.image && (item?.image?.url || item?.image)) out.image = item.image?.url || item?.image;
        if (!out.availability && item?.offers?.availability)
          out.availability = String(item.offers.availability).split("/").pop();
        const offers = item?.offers ? (Array.isArray(item.offers) ? item.offers : [item.offers]) : [];
        for (const off of offers) {
          if (out.price == null && (off?.price ?? off?.lowPrice ?? off?.highPrice)) {
            const v = off.price ?? off.lowPrice ?? off.highPrice;
            out.price = sanitizeNumber(String(v));
          }
          if (off?.priceCurrency) out.currency = String(off.priceCurrency).toUpperCase();
        }
      }
    } catch {}
  }
  return out;
}

// ---------- Shopee ----------
const SHOPEE_ITEM_API = "https://shopee.com.br/api/v4/item/get";
const isShopeeShortHost = (h) => /(^|\.)s\.shopee\.com\.br$/i.test(h) || /(^|\.)shope\.ee$/i.test(h);

function parseShopeeIdsFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/(?:-|\/)i\.([0-9]+)\.([0-9]+)/i);
    if (!m) return null;
    return { shopid: m[1], itemid: m[2] };
  } catch { return null; }
}

async function resolveRedirects(urlStr, maxHops = 10) {
  let current = urlStr;
  for (let i = 0; i < maxHops; i++) {
    const u = new URL(current);
    const isShort = isShopeeShortHost(u.hostname);

    const r = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: { ...HEADERS_HTML, Referer: isShort ? "https://shopee.com.br/" : u.origin + "/" }
    });

    const status = r.status;
    const loc = r.headers.get("location");
    const isDeep = loc && /^shopee:\/\//i.test(loc);

    if (loc && !isDeep) {
      current = new URL(loc, current).toString();
      continue;
    }

    const html = await r.text().catch(() => "");
    const mRefresh = html.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>]+)["']/i);
    if (mRefresh) { current = new URL(mRefresh[1], current).toString(); continue; }
    const mCanonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
    if (mCanonical) { current = new URL(mCanonical[1], current).toString(); continue; }
    const mOg = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
    if (mOg) { current = new URL(mOg[1], current).toString(); continue; }

    if (status >= 200 && status < 300) return current;
    if (status >= 300 && status < 400 && !loc) return current;
    return current;
  }
  return current;
}

async function fetchShopeeItem(shopid, itemid, originalUrl) {
  const apiUrl = `${SHOPEE_ITEM_API}?itemid=${itemid}&shopid=${shopid}`;
  const r = await fetch(apiUrl, { headers: { ...HEADERS_JSON, Referer: originalUrl } });
  if (!r.ok) throw new Error(`Shopee API status ${r.status}`);
  const j = await r.json();
  const d = j?.data;
  if (!d) throw new Error("Shopee API sem data");

  const micro = d.price ?? d.price_min ?? d.price_max ??
    (typeof d.price_min_before_discount === "number" ? d.price_min_before_discount : null);
  const price = (typeof micro === "number") ? micro / 100000 : null;

  const title = d.name || null;
  const image = Array.isArray(d.images) && d.images[0] ? `https://cf.shopee.com.br/file/${d.images[0]}` : null;
  const availability = (typeof d.stock === "number") ? (d.stock > 0 ? "InStock" : "OutOfStock") : null;

  return { title, price, image, availability, currency: "BRL" };
}

// ---------- templates ----------
function formatBRL(value, currency = "BRL") {
  try { return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value); }
  catch { return `R$ ${Number(value).toFixed(2).replace(".", ",")}`; }
}
function buildTemplates({ title, price, currency, affiliateUrl }) {
  const hasPrice = typeof price === "number" && Number.isFinite(price);
  const priceTxt = hasPrice ? formatBRL(price, currency || "BRL") : null;

  const template_line = hasPrice
    ? `${title} por ${priceTxt} ➜ ${affiliateUrl}`
    : `${title} ➜ ${affiliateUrl}`;

  const template_caption = hasPrice
    ? `🔥 ${title}\npor ${priceTxt}\n${affiliateUrl}`
    : `🔥 ${title}\n${affiliateUrl}`;

  return { template_line, template_caption };
}

// ---------- handler ----------
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ success: false, error: "Use POST" }); return; }

  const { url, utm_source = "farofertas" } = req.body || {};
  if (!url || typeof url !== "string") { res.status(400).json({ success: false, error: "missing url" }); return; }

  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid");
  } catch { res.status(400).json({ success: false, error: "invalid url" }); return; }

  const originalAffiliateUrl = url; // preserva teu link curto

  try {
    // 1) Se for encurtador da Shopee, resolve primeiro
    if (isShopeeShortHost(parsed.hostname)) {
      const finalStr = await resolveRedirects(parsed.toString(), 10);
      parsed = new URL(finalStr);
    }

    // 2) Shopee com shopid/itemid → usa API JSON (dados) e devolve o link original no affiliate_url
    const host = parsed.hostname;
    if (/(^|\.)shopee\./i.test(host)) {
      const ids = parseShopeeIdsFromUrl(parsed.toString());
      if (ids) {
        try {
          const data = await fetchShopeeItem(ids.shopid, ids.itemid, parsed.toString());
          const { template_line, template_caption } = buildTemplates({
            title: data.title || "Produto",
            price: data.price ?? null,
            currency: data.currency || "BRL",
            affiliateUrl: originalAffiliateUrl
          });
          res.status(200).json({
            success: true,
            domain: host,
            title: data.title || "Produto",
            price: data.price ?? null,
            currency: data.currency || "BRL",
            image: data.image || null,
            availability: data.availability || null,
            affiliate_url: originalAffiliateUrl, // mantém seu encurtador
            template_line,
            template_caption,
            note: "Shopee JSON API (dados via URL expandida, link afiliado preservado)"
          });
          return;
        } catch (e) {
          // cai pro fetch HTML genérico se a API pública não responder
        }
      }
    }

    // 3) Fluxo genérico (outros domínios)
    let r = await fetch(parsed.toString(), { headers: HEADERS_HTML });
    if (r.status === 404 && !/^www\./i.test(parsed.hostname)) {
      const alt = new URL(parsed); alt.hostname = `www.${parsed.hostname}`;
      r = await fetch(alt.toString(), { headers: HEADERS_HTML });
      parsed = alt;
    }
    const status = r.status;
    const html = await r.text();
    if (status >= 400) { res.status(502).json({ success: false, error: `Destino respondeu ${status}` }); return; }

    const ld = parseJSONLD(html);
    const title = ld.title || parseTitle(html) || "Página";
    let price = ld.price ?? parseMetaPrice(html) ?? null;
    let currency = (ld.currency || parseMetaCurrency(html) || "BRL").toUpperCase();
    const image = ld.image || parseOgImage(html) || null;
    const availability = ld.availability || null;
    if (price != null && !Number.isFinite(price)) price = null;

    const outURL = new URL(parsed.toString());
    const isShopee = /(^|\.)shopee\./i.test(outURL.hostname);

    const affiliate_url = isShopee
      ? originalAffiliateUrl // Shopee: sempre devolve o link que você enviou
      : (() => {
          if (utm_source && !outURL.searchParams.get("utm_source")) {
            outURL.searchParams.set("utm_source", utm_source);
            outURL.searchParams.set("utm_medium", "referral");
            outURL.searchParams.set("utm_campaign", "farofertas");
          }
          return outURL.toString();
        })();

    const { template_line, template_caption } = buildTemplates({
      title,
      price,
      currency,
      affiliateUrl: affiliate_url
    });

    res.status(200).json({
      success: true,
      domain: outURL.hostname,
      title,
      price,
      currency,
      image,
      availability,
      affiliate_url,
      template_line,
      template_caption
    });
  } catch (err) {
    res.status(502).json({ success: false, error: err?.message || "fetch failed" });
  }
}


