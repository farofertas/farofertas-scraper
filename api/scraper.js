// api/scraper.js — versão limpa, validada no Node 20, sem chaves sobrando.
// Robustez para Shopee shortlink, título garantido, shortlink preservado.

const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const htmlHeaders = (ua) => ({
  "User-Agent": ua,
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
});
const jsonHeaders = (ua) => ({
  "User-Agent": ua,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
});

// ---------- helpers ----------
const sanitizeNumber = (txt) => {
  if (!txt) return null;
  const only = txt.replace(/\s/g, "").replace(/[^\d,.-]/g, "");
  const normalized = only.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
};

function sanitizeTitle(t) {
  if (!t) return null;
  const clean = String(t).trim();
  if (/^\d{6,}$/.test(clean)) return null;
  return clean;
}

const parseTitleMeta = (html) =>
  html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
  html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;

const parseOgImage = (html) =>
  html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || null;

function formatBRL(value, currency = "BRL") {
  try { return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value); }
  catch { return `R$ ${Number(value).toFixed(2).replace(".", ",")}`; }
}

function buildTemplates({ title, price, currency, affiliateUrl }) {
  const hasPrice = typeof price === "number" && Number.isFinite(price);
  const priceTxt = hasPrice ? formatBRL(price, currency) : null;
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
    let m = u.pathname.match(/(?:-|\/)i\.([0-9]+)\.([0-9]+)/i);
    if (m) return { shopid: m[1], itemid: m[2] };
    m = u.pathname.match(/\/product\/([0-9]+)\/([0-9]+)/i);
    if (m) return { shopid: m[1], itemid: m[2] };
    return null;
  } catch { return null; }
}

function extractShopeeIdsFromHtml(html) {
  let m = html.match(/i\.(\d+)\.(\d+)/i);
  if (m) return { shopid: m[1], itemid: m[2] };
  const shop = html.match(/"shopid"\s*:\s*"?(\\d+)"?/i)?.[1];
  const item = html.match(/"itemid"\s*:\s*"?(\\d+)"?/i)?.[1];
  if (shop && item) return { shopid: shop, itemid: item };
  return null;
}

function titleFromSlug(urlStr) {
  try {
    const u = new URL(urlStr);
    const m1 = u.pathname.match(/\/([^\/]+)-i\.\d+\.\d+/i);
    if (m1 && m1[1]) return decodeURIComponent(m1[1]).replace(/[-_]+/g, " ");
    return null;
  } catch { return null; }
}

async function fetchShopeeItem(shopid, itemid, referer) {
  const r = await fetch(`${SHOPEE_ITEM_API}?itemid=${itemid}&shopid=${shopid}`, {
    headers: { ...jsonHeaders(UA_DESKTOP), Referer: referer }
  });
  if (!r.ok) throw new Error("Shopee API error");
  const d = (await r.json())?.data;
  if (!d) throw new Error("No data");
  const price = typeof d.price === "number" ? d.price / 100000 : null;
  return {
    title: d.name || null,
    price,
    currency: "BRL",
    image: d.images?.[0] ? `https://cf.shopee.com.br/file/${d.images[0]}` : null,
    availability: d.stock > 0 ? "InStock" : "OutOfStock"
  };
}

// ---------- handler ----------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Use POST" });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ success: false, error: "missing url" });

  const originalAffiliateUrl = url;

  try {
    const u = new URL(url);

    if (isShopeeShortHost(u.hostname) || isShopeeHost(u.hostname)) {
      let ids = parseShopeeIdsFromUrl(u.toString());
      let title = null, price = null;

      if (!ids) {
        const r = await fetch(u.toString(), { headers: htmlHeaders(UA_DESKTOP) });
        const html = await r.text();
        ids = extractShopeeIdsFromHtml(html);
        if (!title) title = sanitizeTitle(parseTitleMeta(html));
      }

      if (ids) {
        try {
          const data = await fetchShopeeItem(ids.shopid, ids.itemid, u.toString());
          title = sanitizeTitle(data.title) || titleFromSlug(u.toString()) || title || "Produto Shopee";
          price = data.price;
        } catch { title = titleFromSlug(u.toString()) || title || "Produto Shopee"; }
      }

      const { template_line, template_caption } = buildTemplates({
        title: title || "Produto Shopee",
        price,
        currency: "BRL",
        affiliateUrl: originalAffiliateUrl
      });

      return res.status(200).json({
        success: true,
        domain: "shopee.com.br",
        title: title || "Produto Shopee",
        price,
        currency: "BRL",
        affiliate_url: originalAffiliateUrl,
        template_line,
        template_caption
      });
    }

    // fallback genérico
    const r = await fetch(url, { headers: htmlHeaders(UA_DESKTOP) });
    const html = await r.text();
    const title = sanitizeTitle(parseTitleMeta(html)) || "Página";
    const { template_line, template_caption } = buildTemplates({
      title,
      price: null,
      currency: "BRL",
      affiliateUrl: url
    });
    return res.status(200).json({
      success: true,
      domain: u.hostname,
      title,
      price: null,
      currency: "BRL",
      affiliate_url: url,
      template_line,
      template_caption
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e) });
  }
}

