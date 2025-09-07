// api/scraper.js
import puppeteer from "puppeteer";

// ----- utils -----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sanitizeNumber = (txt) => {
  if (!txt) return null;
  const only = txt.replace(/\s/g, "").replace(/[^\d,.-]/g, "");
  const normalized = only.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
};

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
    (await get("meta[name='twit]()
