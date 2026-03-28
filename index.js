const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── BASE CONFIG ──────────────────────────────────────
const BASE = 'https://v2.samehadaku.how';
const PROXY = 'https://cors.caliph.my.id/';

// Rotate user agents biar ga keblock
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function getHeaders(referer = BASE) {
  return {
    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Referer': referer,
    'Cache-Control': 'no-cache',
  };
}

// Axios instance dengan timeout lebih panjang
const http = axios.create({ timeout: 25000 });

// Helper: fetch dengan proxy + fallback direct
async function fetchPage(url) {
  const targetUrl = url.startsWith('http') ? url : `${BASE}${url}`;
  
  // Coba dengan proxy dulu
  try {
    const r = await http.get(`${PROXY}${targetUrl}`, {
      headers: getHeaders(targetUrl),
    });
    return r;
  } catch(e1) {
    // Fallback: coba tanpa proxy
    try {
      const r = await http.get(targetUrl, { headers: getHeaders(targetUrl) });
      return r;
    } catch(e2) {
      throw new Error(`Gagal fetch ${targetUrl}: ${e2.message}`);
    }
  }
}

// ── FUNCTIONS ────────────────────────────────────────

async function animeterbaru(page = 1) {
  const res = await fetchPage(`${BASE}/anime-terbaru/page/${page}/`);
  const $ = cheerio.load(res.data);
  const data = [];
  $('.post-show ul li').each((_, e) => {
    const a = $(e).find('.dtla h2 a');
    const title = a.text().trim();
    const url = a.attr('href');
    if(!title || !url) return;
    data.push({
      title,
      url,
      image: $(e).find('.thumb img').attr('src') || $(e).find('.thumb img').attr('data-src'),
      episode: $(e).find('.dtla span:contains("Episode")').text().replace('Episode','').trim(),
    });
  });
  return data;
}

async function search(query) {
  const res = await fetchPage(`${BASE}/?s=${encodeURIComponent(query)}`);
  const $ = cheerio.load(res.data);
  const data = [];
  $('.animpost').each((_, e) => {
    const url = $(e).find('a').attr('href');
    const title = $(e).find('.data .title h2').text().trim() || $(e).find('a').attr('title');
    if(!title || !url) return;
    data.push({
      title,
      image: $(e).find('.content-thumb img').attr('src') || $(e).find('.content-thumb img').attr('data-src'),
      type: $(e).find('.type').text().trim(),
      score: $(e).find('.score').text().trim(),
      url,
    });
  });
  return data;
}

async function detail(link) {
  const targetUrl = link.startsWith('http') ? link : `${BASE}${link}`;
  const res = await fetchPage(targetUrl);
  const $ = cheerio.load(res.data);

  const episodes = [];
  // Coba berbagai selector episode
  const epSelectors = ['.lstepsiode ul li', '.episodelist ul li', '.episode-list li', '#episodelist li'];
  for(const sel of epSelectors) {
    if($(sel).length > 0) {
      $(sel).each((_, e) => {
        const a = $(e).find('a').first();
        const epUrl = a.attr('href');
        const epTitle = a.text().trim() || $(e).find('.lchx a').text().trim();
        if(epUrl) episodes.push({
          title: epTitle || 'Episode',
          url: epUrl,
          date: $(e).find('.date').text().trim(),
        });
      });
      break;
    }
  }

  const info = {};
  // Coba berbagai selector info
  const infoSelectors = ['.anim-senct .right-senc .spe span', '.infoanime .spe span', '.anime-info span'];
  for(const sel of infoSelectors) {
    if($(sel).length > 0) {
      $(sel).each((_, e) => {
        const t = $(e).text();
        if(t.includes(':')) {
          const idx = t.indexOf(':');
          const k = t.slice(0, idx).trim().toLowerCase().replace(/\s+/g, '_');
          const v = t.slice(idx+1).trim();
          if(k && v) info[k] = v;
        }
      });
      break;
    }
  }

  const image = $('meta[property="og:image"]').attr('content')
    || $('.animeinfo img').attr('src')
    || $('.entry-content img').first().attr('src')
    || '';

  const description = ($('.entry-content').text().trim()
    || $('meta[name="description"]').attr('content')
    || '').substring(0, 1000);

  return {
    title: $('title').text().replace(/\s*-\s*Samehadaku.*/i, '').trim() || $('h1').first().text().trim(),
    image,
    description,
    episodes,
    info,
  };
}

// ── WATCH/DOWNLOAD — VERSI FIX ────────────────────────
async function getStreams(link) {
  const targetUrl = link.startsWith('http') ? link : `${BASE}${link}`;
  
  // Step 1: Fetch halaman episode
  const res = await fetchPage(targetUrl);
  const cookies = res.headers['set-cookie']?.map(v => v.split(';')[0]).join('; ') || '';
  const $ = cheerio.load(res.data);

  const streams = [];
  const errors = [];

  // Kumpulin semua server yang tersedia
  const servers = [];
  $('div#server > ul > li, .server-list li, #server li').each((_, li) => {
    const div = $(li).find('div, [data-post]').first();
    const post = div.attr('data-post') || $(li).attr('data-post');
    const nume = div.attr('data-nume') || $(li).attr('data-nume');
    const type = div.attr('data-type') || $(li).attr('data-type');
    const name = $(li).find('span, a').first().text().trim() || `Server ${servers.length + 1}`;
    if(post) servers.push({ post, nume, type, name });
  });

  console.log(`Found ${servers.length} servers for ${targetUrl}`);

  // Coba setiap server
  for(const srv of servers) {
    try {
      const body = new URLSearchParams({
        action: 'player_ajax',
        post: srv.post,
        nume: srv.nume,
        type: srv.type,
      }).toString();

      const ajaxHeaders = {
        ...getHeaders(targetUrl),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookies,
        'Referer': targetUrl,
        'Origin': BASE,
      };

      // Coba dengan proxy dulu
      let ajaxRes;
      try {
        ajaxRes = await http.post(
          `${PROXY}${BASE}/wp-admin/admin-ajax.php`,
          body,
          { headers: ajaxHeaders, timeout: 15000 }
        );
      } catch {
        // Fallback langsung
        ajaxRes = await http.post(
          `${BASE}/wp-admin/admin-ajax.php`,
          body,
          { headers: ajaxHeaders, timeout: 15000 }
        );
      }

      const $$ = cheerio.load(ajaxRes.data);

      // Cari iframe dari berbagai kemungkinan
      let iframeSrc = $$('iframe').attr('src')
        || $$('iframe').attr('data-src')
        || $$('iframe').attr('data-lazy-src');

      // Kalau ada URL langsung di response (bukan iframe)
      if(!iframeSrc) {
        const rawText = typeof ajaxRes.data === 'string' ? ajaxRes.data : JSON.stringify(ajaxRes.data);
        const urlMatch = rawText.match(/https?:\/\/[^\s"'<>]+\.(mp4|m3u8|mkv)[^\s"'<>]*/i);
        if(urlMatch) iframeSrc = urlMatch[0];
      }

      // Cari embed URL dari script
      if(!iframeSrc) {
        const scriptText = $$('script').text();
        const embedMatch = scriptText.match(/(?:file|source|src)\s*[:=]\s*["']([^"']+)["']/i);
        if(embedMatch) iframeSrc = embedMatch[1];
      }

      if(iframeSrc) {
        // Normalize URL
        if(iframeSrc.startsWith('//')) iframeSrc = 'https:' + iframeSrc;
        streams.push({ server: srv.name, url: iframeSrc });
        console.log(`✅ ${srv.name}: ${iframeSrc}`);
      }
    } catch(e) {
      console.log(`❌ ${srv.name}: ${e.message}`);
      errors.push({ server: srv.name, error: e.message });
    }
  }

  // Kalau masih kosong, coba cari embed langsung di halaman
  if(streams.length === 0) {
    const iframesOnPage = [];
    $('iframe').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if(src && src.startsWith('http')) iframesOnPage.push(src);
    });

    if(iframesOnPage.length > 0) {
      iframesOnPage.forEach((src, i) => {
        streams.push({ server: `Stream ${i+1}`, url: src });
      });
    }
  }

  return {
    title: $('h1[itemprop="name"], .entry-title, h1').first().text().trim(),
    streams,
    _debug: { serversFound: servers.length, errors, streamsFound: streams.length }
  };
}

// ── ROUTES ───────────────────────────────────────────

app.get('/api/latest', async (req, res) => {
  try {
    const data = await animeterbaru(req.query.page || 1);
    res.json(data);
  } catch(e) {
    console.error('/api/latest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    if(!req.query.q) return res.status(400).json({ error: 'Query q diperlukan' });
    const data = await search(req.query.q);
    res.json(data);
  } catch(e) {
    console.error('/api/search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/detail', async (req, res) => {
  try {
    if(!req.query.url) return res.status(400).json({ error: 'Parameter url diperlukan' });
    const data = await detail(req.query.url);
    res.json(data);
  } catch(e) {
    console.error('/api/detail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/watch', async (req, res) => {
  try {
    if(!req.query.url) return res.status(400).json({ error: 'Parameter url diperlukan' });
    const data = await getStreams(req.query.url);
    res.json(data);
  } catch(e) {
    console.error('/api/watch error:', e.message);
    res.status(500).json({ error: e.message, streams: [] });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    endpoints: ['/api/latest?page=1', '/api/search?q=naruto', '/api/detail?url=...', '/api/watch?url=...']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server jalan di port ${PORT}`));

module.exports = app;
