// api/scraper.js
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { install, computeExecutablePath } from "@puppeteer/browsers";

// ===== utils =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || "/opt/render/.cache/puppeteer";
const BUILD_ID = process.env.PUPPETEER_BUILD_ID || "stable";

const sanitizeNumber = (txt) => {
  if (!txt) return null;
  const only = txt.replace(/\s/g, "").replace(/[^\d,.-]/g, "");
  const normalized = only.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
};

async function ensureChromePath() {
  try {
    const p = puppeteer.executablePath?.();
    if (p && fs.existsSync(p)) return p;
  } catch {}

  try {
    const computed = computeExecutablePath({
      cacheDir: CACHE_DIR,
      browser: "chrome",
      buildId: BUILD_ID,
      platform: "linux",
      basePath: undefined
    });
    if (computed && fs.existsSync(computed)) return computed;
  } catch {}

  await install({ browser: "chrome", cacheDir: CACHE_DIR, buildId: BUILD_ID });
  const computedAfter = computeExecutablePath({
    cacheDir: CACHE_DIR,
    browser: "chrome",
    buildId: BUILD_ID,
    platform: "linux",
    basePath: undefined
  });
  return computedAfter;
}

async function extractJSONLD(page) {
  try {
    const blocks = await page.$$eval(
      "script[type='application/ld+json']",
      els => els.map(e => e.textContent || "").filter(Boolean)
    );
    const out = { title: null, price: null, currency: "BRL", image: null, availability: null };
    for (const raw of blocks) {
      try {
        const data = JSON.parse(raw);
        const arr = Array.isArray(data) ? data : [data];
        for (const item of arr) {
          if (!out.title && (item.name || item.headline)) out.title = item.name || item.headline;
          if (!out.image && (item.image?.url || item.image)) out.image = item.image?.url || item.image;
          if (!out.availability && item.offers?.availability) {
            out.availability = String(item.offers.availability).split("/").pop();
          }
          const offers = item.offers ? (Array.isArray(item.offers) ? item.offers : [item.offers]) : [];
          for (const off of offers) {
            if (out.price == null && (off?.price ?? off?.lowPrice ?? off?.highPrice)) {
              const v = off.price ?? off.lowPrice ?? off.highPrice;
              out.price = sanitizeNumber(String(v));
            }
            if (off?.priceCurrency) out.currency = off.priceCurrency;
          }
        }
      } catch {}
    }
    return out;
  } catch {
    return { title: null, price: null, currency: "BRL", image: null, availability: null };
  }
}

async function extractMeta(page) {
  const get = async (sel, attr = "content") =>
    page.$eval(sel, el => el.getAttribute(attr)).catch(() => null);

  const title = await (get("meta[property='og:title']") || page.title().catch(() => null));
  const image = await get("meta[property='og:image']");
  const priceMeta =
    (await get("meta[itemprop='price']")) ||
    (await get("meta[property='product:price:amount']")) ||
    (await get("meta[name='twitter:data1']"));
  const currency =
    (await get("meta[itemprop='priceCurrency']")) ||
    (await get("meta[property='product:price:currency']")) ||
    "BRL";

  return {
    title: title || null,
    price: sanitizeNumber(priceMeta),
    currency,
    image: image || null,
    availability: null
  };
}

// ===== domain scrapers =====
async function scrapeShopee(page) {
  const sels = [
    "[data-testid='lblProductPrice']",
    "div:has(> .flex .text-orange) .text-orange",
    "div[role='main'] span:has(> sup) + span"
  ];
  for (const sel of sels) {
    const txt = await page.$eval(sel, el => el.textContent).catch(() => null);
    const price = sanitizeNumber(txt);
    if (price != null) return { price, currency: "BRL" };
  }
  const html = await page.content();
  const m =
    html.match(/"price"\s*:\s*("?[\d\.,]+"?)/i) ||
    html.match(/"finalPrice"\s*:\s*("?[\d\.,]+"?)/i) ||
    html.match(/"minPrice"\s*:\s*("?[\d\.,]+"?)/i);
  if (m?.[1]) {
    const price = sanitizeNumber(String(m[1]).replace(/"/g, ""));
    if (price != null) return { price, currency: "BRL" };
  }
  return { price: null, currency: "BRL" };
}

async function scrapeMercadoLivre(page) {
  const sels = [
    "span.andes-money-amount__fraction",
    ".ui-pdp-price__second-line .andes-money-amount__fraction",
    "[itemprop='price']"
  ];
  for (const sel of sels) {
    const txt = await page.$eval(sel, el => el.textContent).catch(() => null);
    const price = sanitizeNumber(txt);
    if (price != null) return { price, currency: "BRL" };
  }
  return { price: null, currency: "BRL" };
}

async function scrapeAmazon(page) {
  const sels = [
    "#corePrice_feature_div .a-offscreen",
    "#tp_price_block_total_price_ww .a-offscreen",
    "#priceblock_ourprice",
    "#priceblock_dealprice",
    "#sns-base-price .a-offscreen"
  ];
  for (const sel of sels) {
    const txt = await page.$eval(sel, el => el.textContent).catch(() => null);
    const price = sanitizeNumber(txt);
    if (price != null) return { price, currency: "BRL" };
  }
  return { price: null, currency: "BRL" };
}

// ===== HTTP handler =====
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Use POST" });

  const { url, utm_source = "farofertas", extra_wait_ms = 1200 } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ success: false, error: "missing url" });
  }

  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid");
  } catch {
    return res.status(400).json({ success: false, error: "invalid url" });
  }

  let browser;
  try {
    const chromePath = await ensureChromePath();
    if (!chromePath) {
      return res.status(500).json({
        success: false,
        error: "Chrome não encontrado e não foi possível instalar."
      });
    }

    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setJavaScriptEnabled(true);
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      "Upgrade-Insecure-Requests": "1"
    });

    // ---- navegação com retries e fallback ----
    const tryGoto = async (pg, urlStr) => {
      const resp = await pg.goto(urlStr, { waitUntil: "domcontentloaded", timeout: 60000 });
      const status = resp ? resp.status() : 0;
      return { status, finalURL: pg.url() };
    };

    let { status, finalURL } = await tryGoto(page, parsed.toString());

    // Retry 1: alterna www/non-www se 404
    if (status === 404) {
      const alt = new URL(parsed.toString());
      alt.hostname = /^www\./i.test(parsed.hostname)
        ? parsed.hostname.replace(/^www\./i, "")
        : `www.${parsed.hostname}`;
      ({ status, finalURL } = await tryGoto(page, alt.toString()));
    }

    // Retry 2: outro UA se ainda 403/404/406
    if ([403, 404, 406].includes(status)) {
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
      );
      ({ status, finalURL } = await tryGoto(page, parsed.toString()));
    }

    // Fallback estático: pega só <title> via fetch se ainda falhar
    if (status >= 400 || status === 0) {
      try {
        const r = await fetch(parsed.toString(), {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          }
        });
        const txt = await r.text();
        const m = txt.match(/<title[^>]*>([^<]+)<\/title>/i);
        const titleOnly = m ? m[1].trim() : "Página";

        const outURL = new URL(parsed.toString());
        const host = outURL.hostname;
        const isShopee = /(^|\.)shopee\./i.test(host);

        if (!isShopee && utm_source && !outURL.searchParams.get("utm_source")) {
          outURL.searchParams.set("utm_source", utm_source);
          outURL.searchParams.set("utm_medium", "referral");
          outURL.searchParams.set("utm_campaign", "farofertas");
        }

        return res.status(200).json({
          success: true,
          domain: host,
          title: titleOnly,
          price: null,
          currency: "BRL",
          image: null,
          availability: null,
          affiliate_url: outURL.toString(),
          note: `Fallback estático (status original ${status})`
        });
      } catch (e) {
        return res.status(502).json({
          success: false,
          error: `Destino respondeu ${status} e fallback falhou: ${e?.message || e}`
        });
      }
    }

    // ---- extrações normais (quando navegou com sucesso) ----
    await sleep(2000 + Math.min(Math.max(+extra_wait_ms || 0, 0), 5000));
    const host = new URL(finalURL).hostname;

    const [ld, meta] = await Promise.all([extractJSONLD(page), extractMeta(page)]);
    let title = ld.title || meta.title || (await page.title().catch(() => null)) || "Produto";
    let price = ld.price ?? meta.price ?? null;
    let currency = (ld.currency || meta.currency || "BRL")?.toUpperCase();
    let image = ld.image || meta.image || null;
    let availability = ld.availability || meta.availability || null;

    if (/shopee\./i.test(host)) {
      const r = await scrapeShopee(page);
      price = price ?? r.price;
      currency = r.currency || currency;
    } else if (/mercadolivre\./i.test(host)) {
      const r = await scrapeMercadoLivre(page);
      price = price ?? r.price;
      currency = r.currency || currency;
    } else if (/amazon\./i.test(host)) {
      const r = await scrapeAmazon(page);
      price = price ?? r.price;
      currency = r.currency || currency;
    }

    if (price != null && !Number.isFinite(price)) price = null;

    const outURL = new URL(finalURL);
    const isShopee = /(^|\.)shopee\./i.test(host);
    const shouldAddUtm =
      !isShopee && utm_source && !outURL.searchParams.get("utm_source");

    if (shouldAddUtm) {
      outURL.searchParams.set("utm_source", utm_source);
      outURL.searchParams.set("utm_medium", "referral");
      outURL.searchParams.set("utm_campaign", "farofertas");
    }

    return res.status(200).json({
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
    return res.status(500).json({
      success: false,
      error: err?.message || "erro desconhecido no scraper"
    });
  } finally {
    // fecha o browser
    try { if (browser) await browser.close(); } catch {}
  }
}

