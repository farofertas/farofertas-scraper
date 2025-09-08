// api/scraper.js
// Estratégia: apenas HTTP fetch (sem headless). Pega <title>, metatags e JSON-LD.
// Observação: páginas que rendem preço via JS podem retornar price = null.

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent": UA_CHROME,
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Upgrade-Insecure-Requests": "1"
};

const sanitizeNumber = (txt) => {
  if (!txt) return null;
  const only = txt.replace(/\s/g, "").replace(/[^\d,.-]/g, "");
  const normalized = only.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
};

function extractBetween(html, re) {
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

function parseTitle(html) {
  // prioridade: og:title > <title>
  const og = extractBetween(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (og) return og;
  const t = extractBetween(html, /<title[^>]*>([^<]+)<\/title>/i);
  return t || null;
}

function parseOgImage(html) {
  return extractBetween(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
}

function parseMetaPrice(html) {
  // tenta várias convenções comuns
  const itemprop = extractBetween(html, /<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (itemprop) return sanitizeNumber(itemprop);
  const productAmount = extractBetween(html, /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (productAmount) return sanitizeNumber(productAmount);
  const twitterData1 = extractBetween(html, /<meta[^>]+name=["']twitter:data1["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (twitterData1) return sanitizeNumber(twitterData1);
  // fallback frouxo: R$ 1.234,56
  const br = extractBetween(html, /R\$\s*([\d\.\,]+)/i);
  if (br) return sanitizeNumber(br);
  return null;
}

function parseMetaCurrency(html) {
  const itemprop = extractBetween(html, /<meta[^>]+itemprop=["']priceCurrency["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (itemprop) return itemprop.toUpperCase();
  const productCurrency = extractBetween(html, /<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (productCurrency) return productCurrency.toUpperCase();
  return "BRL";
}

function parseJSONLD(html) {
  // captura scripts <script type="application/ld+json">...</script>
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const out = { title: null, price: null, currency: "BRL", image: null, availability: null };
  for (const m of scripts) {
    try {
      const raw = m[1].trim();
      if (!raw) continue;
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        if (!out.title && (item?.name || item?.headline)) out.title = item.name || item.headline;
        if (!out.image && (item?.image?.url || item?.image)) out.image = item.image?.url || item.image;
        if (!out.availability && item?.offers?.availability) {
          out.availability = String(item.offers.availability).split("/").pop();
        }
        const offers = item?.offers ? (Array.isArray(item.offers) ? item.offers : [item.offers]) : [];
        for (const off of offers) {
          if (out.price == null && (off?.price ?? off?.lowPrice ?? off?.highPrice)) {
            const v = off.price ?? off.lowPrice ?? off.highPrice;
            out.price = sanitizeNumber(String(v));
          }
          if (off?.priceCurrency) out.currency = String(off.priceCurrency).toUpperCase();
        }
      }
    } catch {
      // ignora JSON-LD inválido
    }
  }
  return out;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ success: false, error: "Use POST" }); return; }

  const { url, utm_source = "farofertas" } = req.body || {};
  if (!url || typeof url !== "string") {
    res.status(400).json({ success: false, error: "missing url" });
    return;
  }

  // valida URL
  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid");
  } catch {
    res.status(400).json({ success: false, error: "invalid url" });
    return;
  }

  try {
    // tenta URL original
    let r = await fetch(parsed.toString(), { headers: HEADERS });
    // se 404 e não tem www, tenta com www.
    if (r.status === 404 && !/^www\./i.test(parsed.hostname)) {
      const alt = new URL(parsed);
      alt.hostname = `www.${parsed.hostname}`;
      r = await fetch(alt.toString(), { headers: HEADERS });
      parsed = alt; // considera a alternativa se funcionou
    }

    const status = r.status;
    const html = await r.text();

    if (status >= 400) {
      res.status(502).json({ success: false, error: `Destino respondeu ${status}` });
      return;
    }

    // parse básico
    const ld = parseJSONLD(html);
    const metaPrice = parseMetaPrice(html);
    const metaCurrency = parseMetaCurrency(html);

    const title = ld.title || parseTitle(html) || "Página";
    let price = ld.price ?? metaPrice ?? null;
    let currency = (ld.currency || metaCurrency || "BRL").toUpperCase();
    const image = ld.image || parseOgImage(html) || null;
    const availability = ld.availability || null;

    if (price != null && !Number.isFinite(price)) price = null;

    // monta URL final com/sem UTM (não adiciona UTM para Shopee)
    const outURL = new URL(parsed.toString());
    const host = outURL.hostname;
    const isShopee = /(^|\.)shopee\./i.test(host);
    if (!isShopee && utm_source && !outURL.searchParams.get("utm_source")) {
      outURL.searchParams.set("utm_source", utm_source);
      outURL.searchParams.set("utm_medium", "referral");
      outURL.searchParams.set("utm_campaign", "farofertas");
    }

    res.status(200).json({
      success: true,
      domain: host,
      title,
      price,
      currency,
      image,
      availability,
      affiliate_url: outURL.toString()
    });
  } catch (err) {
    res.status(502).json({ success: false, error: err?.message || "fetch failed" });
  }
}


