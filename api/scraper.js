// api/scraper.js
// Objetivo: usar SEMPRE a URL que você mandou no template (affiliate_url),
// mas buscar o TÍTULO na URL FINAL (após redirecionamentos).
// - Resolve shortlinks (ex.: s.shopee.com.br, shope.ee) e outros redirects
// - Lê <title>/og:title e tenta JSON-LD para pegar nome/preço
// - Se ainda faltar, tenta extrair título pelo SLUG da URL final
// - Nunca troca o link no template: mantém a URL original enviada

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const HTML_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Upgrade-Insecure-Requests": "1"
};

function isShopeeHost(h) {
  return /(^|\.)shopee\./i.test(h) || /(^|\.)s\.shopee\.com\.br$/i.test(h) || /(^|\.)shope\.ee$/i.test(h);
}

function sanitizeTitle(t) {
  if (!t) return null;
  const s = String(t).trim();
  // evita “título” que seja só número (ex.: itemid)
  if (/^\d{6,}$/.test(s)) return null;
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

function parseCanonicalOrOgUrl(html) {
  const canon = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1];
  const og = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
  return canon || og || null;
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

function tryParseJSONLD(html) {
  // retorna { title, price } quando possível (bem básico)
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let title = null;
  let price = null;
  for (const m of scripts) {
    try {
      const raw = (m[1] || "").trim();
      if (!raw) continue;
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        if (!title && (item?.name || item?.headline)) {
          title = sanitizeTitle(item.name || item.headline);
        }
        const offers = item?.offers
          ? (Array.isArray(item.offers) ? item.offers : [item.offers])
          : [];
        for (const off of offers) {
          if (price == null && (off?.price ?? off?.lowPrice ?? off?.highPrice)) {
            const v = Number(String(off.price ?? off.lowPrice ?? off.highPrice).replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", "."));
            if (Number.isFinite(v)) price = v;
          }
        }
      }
    } catch {}
  }
  return { title, price };
}

async function resolveFinal(urlStr, refererHost) {
  // 1) tenta seguir redirects automaticamente
  try {
    const r = await fetch(urlStr, {
      method: "GET",
      redirect: "follow",
      headers: { ...HTML_HEADERS, ...(refererHost ? { Referer: `https://${refererHost}/` } : {}) }
    });
    const urlFollow = r.url || urlStr;
    const htmlFollow = await r.text().catch(() => "");
    // 2) se o HTML tiver canonical/og:url, pode apontar melhor a URL final
    const hinted = parseCanonicalOrOgUrl(htmlFollow);
    if (hinted) {
      try {
        const u2 = new URL(hinted, urlFollow);
        return { finalUrl: u2.toString(), html: htmlFollow };
      } catch { /* ignora hinted inválido */ }
    }
    return { finalUrl: urlFollow, html: htmlFollow };
  } catch {
    // fallback: tenta pegar ao menos o HTML
    try {
      const r2 = await fetch(urlStr, { headers: HTML_HEADERS });
      const html2 = await r2.text().catch(() => "");
      return { finalUrl: urlStr, html: html2 };
    } catch {
      return { finalUrl: urlStr, html: "" };
    }
  }
}

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
  try {
    original = new URL(url);
  } catch {
    return res.status(400).json({ success: false, error: "invalid url" });
  }

  // Sempre voltamos o link ORIGINAL no template
  const affiliate_url = url;

  try {
    const refererHost = isShopeeHost(original.hostname) ? "shopee.com.br" : null;

    // Resolve a URL final e pega o HTML de lá
    const { finalUrl, html } = await resolveFinal(original.toString(), refererHost);
    const finalHost = (() => {
      try { return new URL(finalUrl).hostname; } catch { return original.hostname; }
    })();

    // Título: JSON-LD → <title>/og:title → slug → fallback
    const fromLD = tryParseJSONLD(html);
    let title =
      sanitizeTitle(fromLD.title) ||
      sanitizeTitle(parseTitleFromHTML(html)) ||
      titleFromSlug(finalUrl) ||
      (isShopeeHost(finalHost) ? "Produto Shopee" : "Página");

    // Preço (opcional): só se vier no JSON-LD (não vamos “chutar”)
    const price = typeof fromLD.price === "number" ? fromLD.price : null;

    const { template_line, template_caption } = buildTemplates(title, price, affiliate_url, isShopeeHost(finalHost));

    return res.status(200).json({
      success: true,
      domain: finalHost,
      title,
      price,
      currency: "BRL",
      image: null,
      availability: null,
      // MUITO IMPORTANTE: mantemos o link ORIGINAL que você enviou
      affiliate_url,
      template_line,
      template_caption,
      debug_url_final: finalUrl // opcional: ajuda a entender de onde veio o título
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
}

