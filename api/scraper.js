// api/scraper.js — versão enxuta e estável (Node 20)
// Preserva o link original; tenta Shopee via IDs -> API; fallback: <title> ou slug.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

function htmlHeaders() {
  return {
    'User-Agent': UA,
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };
}

function jsonHeaders() {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
  };
}

function sanitizeTitle(t) {
  if (!t) return null;
  const s = String(t).trim();
  if (/^\d{6,}$/.test(s)) return null; // evita só números
  return s;
}

function formatBRL(v) {
  try { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v); }
  catch { return `R$ ${Number(v).toFixed(2).replace('.', ',')}`; }
}

function buildTemplates(title, price, affiliateUrl) {
  const hasPrice = typeof price === 'number' && Number.isFinite(price);
  const safeTitle = title || 'Produto';
  const line = hasPrice ? `${safeTitle} por ${formatBRL(price)} ➜ ${affiliateUrl}` : `${safeTitle} ➜ ${affiliateUrl}`;
  const caption = hasPrice ? `🔥 ${safeTitle}\npor ${formatBRL(price)}\n${affiliateUrl}` : `🔥 ${safeTitle}\n${affiliateUrl}`;
  return { template_line: line, template_caption: caption };
}

function isShopeeHost(h) {
  return /(^|\.)shopee\./i.test(h) || /(^|\.)s\.shopee\.com\.br$/i.test(h) || /(^|\.)shope\.ee$/i.test(h);
}

// IDs por URL: ...-i.shopid.itemid ou /product/shopid/itemid
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

// Tenta extrair IDs de HTML simples (JSON inline comum)
function extractShopeeIdsFromHtml(html) {
  let m = html.match(/(?:^|[^\w])i\.(\d+)\.(\d+)(?:[^\d]|$)/i);
  if (m) return { shopid: m[1], itemid: m[2] };

  const shop1 = html.match(/"shopid"\s*:\s*(\d+)/i);
  const item1 = html.match(/"itemid"\s*:\s*(\d+)/i);
  if (shop1 && item1) return { shopid: shop1[1], itemid: item1[1] };

  const shop2 = html.match(/"shopid_str"\s*:\s*"(\d+)"/i);
  const item2 = html.match(/"itemid_str"\s*:\s*"(\d+)"/i);
  if (shop2 && item2) return { shopid: shop2[1], itemid: item2[1] };

  return null;
}

function titleFromSlug(urlStr) {
  try {
    const u = new URL(urlStr);
    const m1 = u.pathname.match(/\/([^\/]+)-i\.\d+\.\d+(?:$|\?)/i);
    if (m1 && m1[1]) return decodeURIComponent(m1[1]).replace(/[-_]+/g, ' ').trim();
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length) return decodeURIComponent(segs[segs.length - 1]).replace(/[-_]+/g, ' ').trim();
    return null;
  } catch { return null; }
}

function parseTitleMeta(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og && og[1]) return og[1];
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (t && t[1]) return t[1];
  return null;
}

async function fetchShopeeItem(shopid, itemid, referer) {
  const url = `https://shopee.com.br/api/v4/item/get?itemid=${itemid}&shopid=${shopid}`;
  const r = await fetch(url, { headers: { ...jsonHeaders(), Referer: referer } });
  if (!r.ok) throw new Error(`Shopee API ${r.status}`);
  const j = await r.json();
  const d = j && j.data ? j.data : null;
  if (!d) throw new Error('Shopee API sem data');
  const price = typeof d.price === 'number' ? d.price / 100000 : null;
  return { title: d.name || null, price };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Use POST' });

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ success: false, error: 'missing url' });

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ success: false, error: 'invalid url' });
  }

  const originalAffiliateUrl = url;

  try {
    if (isShopeeHost(parsed.hostname)) {
      // 1) tenta IDs direto da URL
      let ids = parseShopeeIdsFromUrl(parsed.toString());
      let title = null;
      let price = null;

      // 2) se não tiver IDs, baixa HTML uma vez e tenta extrair
      let html = null;
      if (!ids) {
        const r = await fetch(parsed.toString(), { headers: htmlHeaders() });
        html = await r.text().catch(() => '');
        ids = extractShopeeIdsFromHtml(html || '');
        title = sanitizeTitle(parseTitleMeta(html || '')) || title;
      }

      // 3) se tiver IDs, tenta API pra pegar nome/preço
      if (ids) {
        try {
          const data = await fetchShopeeItem(ids.shopid, ids.itemid, parsed.toString());
          title = sanitizeTitle(data.title) || titleFromSlug(parsed.toString()) || title || 'Produto Shopee';
          price = data.price;
        } catch {
          // API falhou → usa slug/HTML
          title = titleFromSlug(parsed.toString()) || title || 'Produto Shopee';
          price = null;
        }
      } else {
        // 4) sem IDs — usa <title> ou slug como fallback
        if (!html) {
          const r2 = await fetch(parsed.toString(), { headers: htmlHeaders() });
          html = await r2.text().catch(() => '');
        }
        title = sanitizeTitle(parseTitleMeta(html || '')) || titleFromSlug(parsed.toString()) || 'Produto Shopee';
        price = null;
      }

      const { template_line, template_caption } = buildTemplates(title, price, originalAffiliateUrl);
      return res.status(200).json({
        success: true,
        domain: 'shopee.com.br',
        title,
        price,
        currency: 'BRL',
        image: null,
        availability: null,
        affiliate_url: originalAffiliateUrl,
        template_line,
        template_caption
      });
    }

    // Outros domínios: pega <title> e monta o template (sem preço)
    const r = await fetch(parsed.toString(), { headers: htmlHeaders() });
    const html = await r.text().catch(() => '');
    const title = sanitizeTitle(parseTitleMeta(html || '')) || 'Página';
    const { template_line, template_caption } = buildTemplates(title, null, parsed.toString());

    return res.status(200).json({
      success: true,
      domain: parsed.hostname,
      title,
      price: null,
      currency: 'BRL',
      image: null,
      availability: null,
      affiliate_url: parsed.toString(),
      template_line,
      template_caption
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
}

}


