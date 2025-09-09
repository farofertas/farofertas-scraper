// api/scraper.js
// 1) Resolve redirects e lê HTML da URL FINAL.
// 2) Se for Shopee, extrai shopid/itemid de múltiplos padrões (inclui /opaanlp/{shopid}/{itemid})
//    e chama a API JSON para obter TÍTULO/PREÇO. Se não rolar, usa <title>/og:title ou slug.
// 3) SEMPRE preserva a URL ORIGINAL enviada (shortlink) em affiliate_url.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const HTML_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Upgrade-Insecure-Requests": "1"
};

const JSON_HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
};

function isShopeeHost(h) {
  return /(^|\.)shopee\./i.test(h) || /(^|\.)s\.shopee\.com\.br$/i.test(h) || /(^|\.)shope\.ee$/i.test(h);
}

function sanitizeTitle(t) {
  if (!t) return null;
  const s = String(t).trim();
  if (/^\d{6,}$/.test(s)) return null; // evita só números
  return s;
}

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

function parseTitleFromHTML(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (og) return og.trim();
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  if (t) return t.trim();
  return null;
}

function parseCanonicalOrOgUrl(html, baseUrl) {
  const canon = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1];
  const og = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const cand = canon || og;
  if (!cand) return null;
  try { return new URL(cand, baseUrl).toString(); }
  catch { return null; }
}

function titleFromSlug(urlStr) {
  try {
    const u = new URL(urlStr);
    // /<slug>-i.shopid.itemid
    let m = u.pathname.match(/\/([^\/]+)-i\.\d+\.\d+(?:$|\?)/i);
    if (m?.[1]) {
      const s = decodeURIComponent(m[1]).replace(/[-_]+/g, " ").trim();
      return sanitizeTitle(s);
    }
    // /product/shopid/itemid com slug antes
    m = u.pathname.match(/\/([^\/]+)\/product\/\d+\/\d+(?:$|\?)/i);
    if (m?.[1]) {
      const s = decodeURIComponent(m[1]).replace(/[-_]+/g, " ").trim();
      return sanitizeTitle(s);
    }
    // último segmento legível
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length) {
      const s = decodeURIComponent(segs[segs.length - 1]).replace(/[-_]+/g, " ").trim();
      return sanitizeTitle(s);
    }
    return null;
  } catch {
    return null;
  }
}

// --------- Shopee IDs ---------
// Suporta: -i.shopid.itemid | /product/shopid/itemid | /opaanlp/shopid/itemid | genérico: dois segmentos numéricos seguidos
function parseShopeeIdsFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const p = u.pathname;

    // ...-i.shopid.itemid
    let m = p.match(/(?:-|\/)i\.([0-9]+)\.([0-9]+)/i);
    if (m) return { shopid: m[1], itemid: m[2] };

    // /product/shopid/itemid
    m = p.match(/\/product\/([0-9]+)\/([0-9]+)/i);
    if (m) return { shopid: m[1], itemid: m[2] };

    // /opaanlp/shopid/itemid (e variações de “nlp/affiliate/outlink”)
    m = p.match(/\/(?:opaanlp|affiliate|applink|nlp|out|outlink)\/([0-9]+)\/([0-9]+)(?:[\/\?#]|$)/i);
    if (m) return { shopid: m[1], itemid: m[2] };

    // Genérico: dois segmentos numéricos consecutivos → retorna ambos para tentar
    const segs = p.split("/").filter(Boolean);
    for (let i = 0; i < segs.length - 1; i++) {
      if (/^\d+$/.test(segs[i]) && /^\d+$/.test(segs[i + 1])) {
        return { shopid: segs[i], itemid: segs[i + 1], ambiguous: true };
      }
    }

    return null;
  } catch {
    return null;
  }
}

// Do HTML (inclui *_str)
function extractShopeeIdsFromHtml(html) {
  let m = html.match(/(?:^|[^\w])i\.(\d+)\.(\d+)(?:[^\d]|$)/i);
  if (m) return { shopid: m[1], itemid: m[2] };
  const shop1 = html.match(/"shopid"\s*:\s*(\d+)/i)?.[1];
  const item1 = html.match(/"itemid"\s*:\s*(\d+)/i)?.[1];
  if (shop1 && item1) return { shopid: shop1, itemid: item1 };
  const shop2 = html.match(/"shopid_str"\s*:\s*"(\d+)"/i)?.[1];
  const item2 = html.match(/"itemid_str"\s*:\s*"(\d+)"/i)?.[1];
  if (shop2 && item2) return { shopid: shop2, itemid: item2 };
  return null;
}

async function fetchShopeeItem(shopid, itemid, refererUrl) {
  const apiUrl = `https://shopee.com.br/api/v4/item/get?itemid=${itemid}&shopid=${shopid}`;
  const r = await fetch(apiUrl, { headers: { ...JSON_HEADERS, Referer: refererUrl } });
  if (!r.ok) throw new Error(`Shopee API ${r.status}`);
  const j = await r.json();
  const d = j?.data;
  if (!d) throw new Error("Shopee API sem data");
  const micro = typeof d.price === "number" ? d.price : null;
  const price = micro != null ? micro / 100000 : null;
  const title = d.name || null;
  return { title, price };
}

// Tenta a API na ordem informada; se falhar e pair parecer ambíguo, tenta invertido.
async function resolveShopeeTitlePrice(ids, refererUrl) {
  if (!ids) return { title: null, price: null };
  const tryPairs = [];
  if (ids.ambiguous) {
    tryPairs.push({ shopid: ids.shopid, itemid: ids.itemid });
    tryPairs.push({ shopid: ids.itemid, itemid: ids.shopid }); // swap
  } else {
    tryPairs.push({ shopid: ids.shopid, itemid: ids.itemid });
  }
  for (const pair of tryPairs) {
    try {
      const data = await fetchShopeeItem(pair.shopid, pair.itemid, refererUrl);
      return { title: sanitizeTitle(data.title), price: data.price };
    } catch { /* tenta próxima combinação */ }
  }
  return { title: null, price: null };
}

// --------- Redirect/HTML ---------
function parseCanonicalOrOgUrlOnly(html) {
  const canon = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1];
  const og = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
  return canon || og || null;
}

async function resolveFinal(urlStr) {
  try {
    const r = await fetch(urlStr, { method: "GET", redirect: "follow", headers: HTML_HEADERS });
    const finalUrl = r.url || urlStr;
    const html = await r.text().catch(() => "");
    const hinted = parseCanonicalOrOgUrlOnly(html) || finalUrl;
    return { finalUrl: hinted, html };
  } catch {
    try {
      const r2 = await fetch(urlStr, { headers: HTML_HEADERS });
      const html2 = await r2.text().catch(() => "");
      return { finalUrl: urlStr, html: html2 };
    } catch {
      return { finalUrl: urlStr, html: "" };
    }
  }
}

// --------- Handler ---------
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Use POST" });

  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ success: false, error: "missing url" });
  }

  let original;
  try { original = new URL(url); }
  catch { return res.status(400).json({ success: false, error: "invalid url" }); }

  const affiliate_url = url; // sempre retorna o link original

  try {
    const { finalUrl, html } = await resolveFinal(original.toString());
    const finalHost = (() => { try { return new URL(finalUrl).hostname; } catch { return original.hostname; } })();
    const isShopee = isShopeeHost(finalHost);

    let title = null;
    let price = null;

    if (isShopee) {
      // 1) IDs pela URL final
      let ids = parseShopeeIdsFromUrl(finalUrl);

      // 2) se não houver, IDs pelo HTML
      if (!ids) ids = extractShopeeIdsFromHtml(html || "");

      // 3) se ainda não, IDs por canonical/og:url do HTML
      if (!ids) {
        const hinted = parseCanonicalOrOgUrl(html || "", finalUrl);
        if (hinted) ids = parseShopeeIdsFromUrl(hinted);
      }

      // 4) tenta API (com swap em caso ambíguo)
      if (ids) {
        const viaApi = await resolveShopeeTitlePrice(ids, finalUrl);
        title = viaApi.title || null;
        price = viaApi.price;
      }

      // 5) Fallbacks de título se a API não deu
      if (!title) {
        title = sanitizeTitle(parseTitleFromHTML(html || "")) || titleFromSlug(finalUrl);
      }
    } else {
      // Não Shopee
      title = sanitizeTitle(parseTitleFromHTML(html || "")) || titleFromSlug(finalUrl) || "Página";
      price = null;
    }

    if (!title) title = isShopee ? "Produto Shopee" : "Página";

    const { template_line, template_caption } = buildTemplates(title, price, affiliate_url, isShopee);

    return res.status(200).json({
      success: true,
      domain: finalHost,
      title,
      price,
      currency: "BRL",
      image: null,
      availability: null,
      affiliate_url,          // mantém seu shortlink
      template_line,
      template_caption,
      debug_url_final: finalUrl
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
}

