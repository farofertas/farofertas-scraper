import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

// 🔧 Recomendações para Vercel
chromium.setHeadlessMode = true;
chromium.setGraphicsMode = false;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "Use POST" });
    }

    const { url } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ success: false, error: "missing url" });
    }

    const browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        // dicas pra ambientes serverless:
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox"
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath, // <- usa binário empacotado
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000); // um respiro pro JS da página

    const finalURL = page.url();

    // --- Extração básica (você pode manter a versão “completa” que te passei antes) ---
    let title = null;
    let price = null;
    let currency = "BRL";

    const ogTitle = await page
      .$eval("meta[property='og:title']", el => el.getAttribute("content"))
      .catch(() => null);
    const pageTitle = await page.title().catch(() => null);
    title = ogTitle || pageTitle || "Produto Shopee";

    // tenta achar preço em ld+json
    const ldBlocks = await page
      .$$eval("script[type='application/ld+json']", els => els.map(e => e.textContent))
      .catch(() => []);
    for (const raw of ldBlocks) {
      try {
        const data = JSON.parse(raw);
        const arr = Array.isArray(data) ? data : [data];
        for (const item of arr) {
          if (item?.offers) {
            const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
            for (const off of offers) {
              if (!price && (off.price || off.lowPrice)) {
                price = Number((off.price || off.lowPrice).toString().replace(",", "."));
              }
              if (off.priceCurrency) currency = off.priceCurrency;
            }
          }
        }
      } catch {}
    }

    await browser.close();

    if (price !== null) {
      price = Number(price);
      if (Number.isNaN(price)) price = null;
    }

    return res.status(200).json({
      success: true,
      title,
      price,
      currency,
      affiliate_url: finalURL
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
}
