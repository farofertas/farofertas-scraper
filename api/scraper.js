  // --- modo de teste: força usar apenas fetch sem headless ---
  const { mode } = req.body || {};
  if (mode === "fetch") {
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      const html = await r.text();
      const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = (m ? m[1].trim() : "Página");

      const outURL = new URL(url);
      const isShopee = /(^|\.)shopee\./i.test(outURL.hostname);
      if (!isShopee && !outURL.searchParams.get("utm_source")) {
        outURL.searchParams.set("utm_source", "farofertas");
        outURL.searchParams.set("utm_medium", "referral");
        outURL.searchParams.set("utm_campaign", "farofertas");
      }

      return res.status(200).json({
        success: true,
        mode: "fetch",
        status: r.status,
        domain: outURL.hostname,
        title,
        price: null,
        currency: "BRL",
        image: null,
        availability: null,
        affiliate_url: outURL.toString()
      });
    } catch (e) {
      return res.status(502).json({ success: false, error: `fetch failed: ${e?.message || e}` });
    }
  }

