// api/scraper.js
// Fetch-only (sem headless) com shortlink Shopee robusto.
// Estratégias extra para s.shopee.com.br/shope.ee:
// 1) redirect:'follow' para capturar Response.url
// 2) loop manual + meta refresh + canonical + og:url
// 3) troca de User-Agent desktop/mobile
// 4) extração de shopid/itemid via URL ou HTML -> Shopee JSON API
// 5) SEMPRE preserva o link original enviado em affiliate_url

const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const baseHTMLHeaders = (ua) => ({
  "User-Agent": ua,
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Upgrade-Insecure-Requests": "1"
});
const baseJSONHeaders = (ua) => ({
  "User-Agent": ua,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
});

// ---------- helpers gerais ----------
const sanitizeNumber = (txt) => {
  if (!txt) return null;
  const only = txt.replace(/\s/g, "").replace(/[^\d,.-]/g, "");
  const normalized = only.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
};
const extractBetween = (html, re) => (html.match(re)?.[1]?.trim() ?? null);
const parseTitle = (html) =>
  extractBetween(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
  extractBetween(html, /<title[^>]*>([^<]+)<\/title>/i) || null;
const parseOgImage = (html) =>
  extractBetween(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
const parseMetaPrice = (html) => {
  const v1 = extractBetween(html, /<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (v1) return sanitizeNumber(v1);
  const v2 = extractBetween(html, /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (v2) return sanitizeNumber(v2);
  const v3 = extractBetween(html, /<meta[^>]+name=["']twitter:data1["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (v3) return sanitizeNumber(v3);
  const v4 = extractBetween(html, /R\$\s*([\d\.\,]+)/i);
  if (v4) return sanitizeNumber(v4);
  return null;
};
const parseMetaCurrency = (html) => {
  const c1 = extractBetween(html, /<meta[^>]+itemprop=["']priceCurrency["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (c1) return c1.toUpperCase();
  const c2 = extractBetween(html, /<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (c2) return c2.toUpperCase();
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
function formatBRL(value, currency = "BRL") {
  try { return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value); }
  catch { return `R$ ${Number(value).toFixed(2).replace(".", ",")}`; }
}
function buildTemplates({ title, price, currency, affiliateUrl }) {
  const hasPrice = typeof price === "number" && Number.isFinite(price);
  const priceTxt = hasPrice ? formatBRL(price, currency || "BRL") : null;
  const safeTitle = title || "Produto";
  const template_line = hasPrice
    ? `${safeTitle} por ${priceTxt} ➜ ${affiliateUrl}`
    : `${safeTitle} ➜ ${affiliateUrl}`;
  const template_caption = hasPrice
    ? `🔥 ${safeTitle}\npor ${priceTxt}\n${affiliateUrl}`
    : `🔥 ${safeTitle}\n${affiliateUrl}`;
  return { template_line, template_caption };
}

// ---------- Shopee ----------
const SHOPEE_ITEM_API = "https://shopee.com.br/api/v4/item/get";
const isShopeeShortHost = (h) => /(^|\.)s\.shopee\.com\.br$/i.test(h) || /(^|\.)shope\.ee$/i.test(h);
const isShopeeHost = (h) => /(^|\.)shopee\./i.test(h);

function parseShopeeIdsFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/(?:-|\/)i\.([0-9]+)\.([0-9]+)/i);
    if (!m) return null;
    return { shopid: m[1], itemid: m[2] };
  } catch { return null; }
}
function extractShopeeIdsFromHtml(html) {
  let m = html.match(/(?:^|[^\w])i\.(\d+)\.(\d+)(?:[^\d]|$)/i);
  if (m) return { shopid: m[1], itemid: m[2] };
  const shop = html.match(/"shopid"\s*:\s*(\d+)/i);
  const item = html.match(/"itemid"\s*:\s*(\d+)/i);
  if (shop && item) return { shopid: shop[1], itemid: item[1] };
  const shop2 = html.match(/shopid\s*:\s*(\d+)/i);
  const item2 = html.match(/itemid\s*:\s*(\d+)/i);
  if (shop2 && item2) return { shopid: shop2[1], itemid: item2[1] };
  return null;
}

// 1) tentativa rápida: seguir redirects automaticamente e pegar response.url
async function tryFollowRedirect(urlStr, ua) {
  const r = await fetch(urlStr, {
    method: "GET",
    redirect: "follow",
    headers: { ...baseHTMLHeaders(ua), Referer: "https://shopee.com.br/" }
  });
  // Mesmo com follow, alguns shorteners respondem 200 com HTML de ponte.
  // Ainda assim, Response.url costuma refletir o último salto.
  return { finalUrl: r.url || urlStr, status: r.status, html: await r.text().catch(() => "") };
}

// 2) loop manual com meta refresh, canonical e og:url
async function resolveRedirectsManual(urlStr, ua, maxHops = 10) {
  let current = urlStr;
  for (let i = 0; i < maxHops; i++) {
    const u = new URL(current);
    const isShort = isShopeeShortHost(u.hostname);
    const r = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: { ...baseHTMLHeaders(ua), Referer: isShort ? "https://shopee.com.br/" : u.origin + "/" }
    });
    const status = r.status;
    const loc = r.headers.get("location");
    const isDeep = loc && /^shopee:\/\//i.test(loc);
    if (loc && !isDeep) { current = new URL(loc, current).toString(); continue; }

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

// resolvedor combinado: tenta follow (desktop→mobile), depois manual (desktop→mobile)
async function resolveShortShopee(urlStr) {
  // follow desktop
  try {
    const r1 = await tryFollowRedirect(urlStr, UA_DESKTOP);
    if (isShopeeHost(new URL(r1.finalUrl).hostname)) return r1.finalUrl;
    // follow mobile
    const r2 = await tryFollowRedirect(urlStr, UA_MOBILE);
    if (isShopeeHost(new URL(r2.finalUrl).hostname)) return r2.finalUrl;
    // manual desktop
    const r3 = await resolveRedirectsManual(urlStr, UA_DESKTOP, 10);
    if (isShopeeHost(new URL(r3).hostname)) return r3;
    // manual mobile
    const r4 = await resolveRedirectsManual(urlStr, UA_MOBILE, 10);
    return r4;
  } catch {
    // fallback bruto: devolve original
    return urlStr;
  }
}

async function fetchShopeeItem(shopid, itemid, originalUrl) {
  // Usa UA desktop para API
  const r = await fetch(`https://shopee.com.br/api/v4/item/get?itemid=${itemid}&shopid=${shopid}`, {
    headers: { ...baseJSONHeaders(UA_DESKTOP), Referer: originalUrl }
  });
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

  const originalAffiliateUrl = url; // preserva teu shortlink/afiliado

  try {
    // 1) Shortlink da Shopee? resolve agressivamente
    if (isShopeeShortHost(parsed.hostname)) {
      const finalStr = await resolveShortShopee(parsed.toString());
      parsed = new URL(finalStr);
    }

    // 2) Shopee: tenta IDs via URL OU HTML; se tiver, usa API JSON (dados) e devolve o link original
    const host = parsed.hostname;
    if (isShopeeHost(host)) {
      // (a) IDs na URL
      let ids = parseShopeeIdsFromUrl(parsed.toString());
      // (b) se faltou, baixa HTML (UA desktop) e tenta achar IDs dentro
      let htmlForIds = null;
      if (!ids) {
        const rForIds = await fetch(parsed.toString(), { headers: { ...baseHTMLHeaders(UA_DESKTOP), Referer: "https://shopee.com.br/" } });
        htmlForIds = await rForIds.text().catch(() => "");
        ids = extractShopeeIdsFromHtml(htmlForIds || "");
        // (c) como último tiro, tenta HTML com UA mobile
        if (!ids) {
          const rForIdsM = await fetch(parsed.toString(), { headers: { ...baseHTMLHeaders(UA_MOBILE), Referer: "https://shopee.com.br/" } });
          const htmlM = await rForIdsM.text().catch(() => "");
          ids = extractShopeeIdsFromHtml(htmlM || "");
        }
      }

      if (ids) {
        try {
          const data = await fetchShopeeItem(ids.shopid, ids.itemid, parsed.toString());
          const safeTitle = data.title || "Produto Shopee";
          const { template_line, template_caption } = buildTemplates({
            title: safeTitle, price: data.price ?? null, currency: data.currency || "BRL",
            affiliateUrl: originalAffiliateUrl
          });
          res.status(200).json({
            success: true,
            domain: host,
            title: safeTitle,
            price: data.price ?? null,
            currency: data.currency || "BRL",
            image: data.image || null,
            availability: data.availability || null,
            affiliate_url: originalAffiliateUrl, // mantém teu shortlink
            template_line, template_caption,
            note: "Shopee JSON API (IDs via URL/HTML; shortlink preservado)"
          });
          return;
        } catch {
          // cai pro fallback de título
        }
      }

      // Fallback: tenta só título (UA desktop -> mobile)
      const r1 = await fetch(parsed.toString(), { headers: { ...baseHTMLHeaders(UA_DESKTOP), Referer: "https://shopee.com.br/" } });
      let html = await r1.text().catch(() => "");
      if (!html || html.length < 1000) {
        const r2 = await fetch(parsed.toString(), { headers: { ...baseHTMLHeaders(UA_MOBILE), Referer: "https://shopee.com.br/" } });
        html = await r2.text().catch(() => html);
      }
      const titleFallback = parseTitle(html) || "Produto Shopee";
      const { template_line, template_caption } = buildTemplates({
        title: titleFallback, price: null, currency: "BRL", affiliateUrl: originalAffiliateUrl
      });
      res.status(200).json({
        success: true,
        domain: host,
        title: titleFallback,
        price: null,
        currency: "BRL",
        image: null,
        availability: null,
        affiliate_url: originalAffiliateUrl,
        template_line, template_caption,
        note: "Fallback HTML Shopee (sem IDs)"
      });
      return;
    }

    // 3) Fluxo genérico (outros domínios)
    let r = await fetch(parsed.toString(), { headers: baseHTMLHeaders(UA_DESKTOP) });
    if (r.status === 404 && !/^www\./i.test(parsed.hostname)) {
      const alt = new URL(parsed); alt.hostname = `www.${parsed.hostname}`;
      r = await fetch(alt.toString(), { headers: baseHTMLHeaders(UA_DESKTOP) });
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
    const affiliate_url = (() => {
      if (utm_source && !outURL.searchParams.get("utm_source")) {
        outURL.searchParams.set("utm_source", utm_source);
        outURL.searchParams.set("utm_medium", "referral");
        outURL.searchParams.set("utm_campaign", "farofertas");
      }
      return outURL.toString();
    })();

    const { template_line, template_caption } = buildTemplates({
      title, price, currency, affiliateUrl: affiliate_url
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

