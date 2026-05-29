// Real retrieval for DeepDive "Get Links" / "Get Videos" thread actions.
// Replaces model-recalled (often hallucinated/dead) links with live results:
//   - Links: Gemini with Google Search grounding, then liveness-verified.
//   - Videos: YouTube Data API v3, existence-verified and ranked by recency+quality.
// Runs in the Electron main process.

const { getProviderKey } = require('./keystore.cjs');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AIOS-DeepDive/1.0';
const VERIFY_TIMEOUT_MS = 8000;

function parseTag(text, tag) {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

// Verify a URL is reachable. We follow redirects and KEEP pages that exist but
// merely block bots (401/403/405/429) — they still open fine in the user's
// browser. Only clear "gone" / server-error / network failures are dropped.
async function verifyUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  const opts = { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': UA } };
  try {
    let res = await fetch(url, { ...opts, method: 'HEAD' });
    // Some servers don't implement HEAD — retry with GET.
    if (res.status === 405 || res.status === 501 || res.status === 400) {
      res = await fetch(url, { ...opts, method: 'GET' });
    }
    const live = res.status >= 200 && res.status < 500 && res.status !== 404 && res.status !== 410;
    return { live, finalUrl: res.url || url, status: res.status };
  } catch {
    return { live: false, finalUrl: url, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Find real, varied, live web links relevant to the selected context.
async function findLinks(context) {
  const key = getProviderKey('gemini');
  if (!key) throw new Error('Gemini key not configured — it powers web-search grounding for links. Add it in the Models tab.');

  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({ apiKey: key });

  const prompt = `You are a research assistant helping with a "deep dive". The user selected this context:
"""
${context.slice(0, 4000)}
"""

Using live web search, find 7-10 genuinely useful, currently-live web pages that support, expand, or explain THIS specific context. Prioritize a VARIETY of high-quality sources: an authoritative reference (e.g. Wikipedia), in-depth articles, official documentation or primary sources, and reputable explainers. Avoid SEO spam, content farms, and pages likely to be dead.

First write ONE short paragraph (2-3 sentences) that interprets the specific context and explains what kinds of resources you gathered. Then output a JSON array of the links.

Respond in EXACTLY this format and nothing else:
<intro>one short paragraph here</intro>
<json>[{"title":"Page title","url":"https://...","source":"example.com","reason":"one line on why it's relevant to this context"}]</json>`;

  const result = await client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { tools: [{ googleSearch: {} }] },
  });

  const text = result.text || '';
  const intro = parseTag(text, 'intro') || 'Here are real, current resources related to your selection.';

  let candidates = [];
  const jsonStr = parseTag(text, 'json') || (text.match(/\[[\s\S]*\]/)?.[0] ?? '');
  if (jsonStr) {
    try {
      const arr = JSON.parse(jsonStr);
      if (Array.isArray(arr)) {
        candidates = arr
          .filter(x => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url))
          .map(x => ({
            title: String(x.title || x.url).slice(0, 160),
            url: x.url,
            source: String(x.source || domainOf(x.url)).slice(0, 60),
            reason: String(x.reason || '').slice(0, 200),
          }));
      }
    } catch { /* fall through to grounding backup */ }
  }

  // Backup: pull URLs from grounding metadata if the model gave us too few.
  if (candidates.length < 3) {
    const chunks = result.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    for (const c of chunks) {
      const uri = c?.web?.uri;
      if (uri && !candidates.some(x => x.url === uri)) {
        candidates.push({ title: c.web.title || domainOf(uri), url: uri, source: domainOf(uri), reason: '' });
      }
    }
  }

  // Verify liveness concurrently, de-dupe by final domain+path, cap the list.
  const verified = await Promise.all(
    candidates.map(async c => {
      const v = await verifyUrl(c.url);
      return v.live ? { ...c, url: v.finalUrl, source: c.source || domainOf(v.finalUrl) } : null;
    }),
  );
  const seen = new Set();
  const items = [];
  for (const c of verified) {
    if (!c) continue;
    const dedupeKey = domainOf(c.url) + new URL(c.url).pathname;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    items.push(c);
    if (items.length >= 10) break;
  }

  return { intro, items };
}

function isoDurationToText(iso) {
  if (!iso) return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return '';
  const [h, min, s] = [m[1] ? +m[1] : 0, m[2] ? +m[2] : 0, m[3] ? +m[3] : 0];
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}

// Find real, existing YouTube videos for the context, ranked by recency + quality.
async function findVideos(context) {
  const ytKey = getProviderKey('youtube');
  if (!ytKey) throw new Error('YouTube Data API key not configured. Add a "YouTube" key in the Models tab (enable "YouTube Data API v3" in Google Cloud).');

  // Craft a focused query + intro with Gemini when available; else use the raw context.
  let query = context.replace(/\s+/g, ' ').trim().slice(0, 120);
  let intro = '';
  const geminiKey = getProviderKey('gemini');
  if (geminiKey) {
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const client = new GoogleGenAI({ apiKey: geminiKey });
      const r = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
          role: 'user',
          parts: [{
            text: `The user is researching this context during a deep dive:
"""
${context.slice(0, 2000)}
"""
Write a concise YouTube search query (3-7 words) that would surface high-quality, recent, creative videos about the SPECIFIC topic here. Also write ONE short sentence introducing what to look for.

Respond EXACTLY as:
<query>search query</query>
<intro>one sentence</intro>`,
          }],
        }],
      });
      const t = r.text || '';
      query = parseTag(t, 'query') || query;
      intro = parseTag(t, 'intro');
    } catch { /* use fallbacks */ }
  }

  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.search = new URLSearchParams({
    key: ytKey, part: 'snippet', q: query, type: 'video',
    maxResults: '25', order: 'relevance', videoEmbeddable: 'true', safeSearch: 'moderate',
  }).toString();
  const sres = await fetch(searchUrl);
  const sdata = await sres.json().catch(() => ({}));
  if (!sres.ok) throw new Error(sdata?.error?.message || `YouTube search failed (HTTP ${sres.status})`);
  const ids = (sdata.items || []).map(i => i.id?.videoId).filter(Boolean);
  if (!ids.length) return { intro: intro || 'No videos found for this topic.', items: [] };

  // videos.list returns only videos that actually exist & are accessible —
  // this is our existence verification, plus the stats we rank on.
  const vUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  vUrl.search = new URLSearchParams({
    key: ytKey, part: 'snippet,statistics,contentDetails,status', id: ids.join(','),
  }).toString();
  const vres = await fetch(vUrl);
  const vdata = await vres.json().catch(() => ({}));
  if (!vres.ok) throw new Error(vdata?.error?.message || `YouTube lookup failed (HTTP ${vres.status})`);

  const now = Date.now();
  const items = (vdata.items || [])
    .filter(v => v.status?.privacyStatus === 'public' && v.snippet?.liveBroadcastContent === 'none')
    .map(v => {
      const views = Number(v.statistics?.viewCount || 0);
      const likes = Number(v.statistics?.likeCount || 0);
      const publishedAt = v.snippet?.publishedAt;
      const ageDays = publishedAt ? (now - new Date(publishedAt).getTime()) / 86400000 : 9999;
      const recency = Math.max(0, 1 - ageDays / 1095);          // ~3-year decay
      const engagement = views > 0 ? Math.min(1, (likes / views) * 50) : 0; // like ratio
      const popularity = Math.min(1, Math.log10(views + 1) / 7); // ~10M views ≈ 1
      const score = recency * 0.45 + engagement * 0.2 + popularity * 0.35;
      return {
        title: v.snippet.title,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        videoId: v.id,
        channel: v.snippet.channelTitle,
        channelUrl: `https://www.youtube.com/channel/${v.snippet.channelId}`,
        publishedAt,
        viewCount: views,
        likeCount: likes,
        duration: isoDurationToText(v.contentDetails?.duration),
        thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '',
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ score, ...rest }) => rest); // drop internal score

  return { intro: intro || 'Recent, well-received videos on this topic:', items };
}

module.exports = { findLinks, findVideos };
