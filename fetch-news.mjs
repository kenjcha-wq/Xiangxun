/**
 * 象讯 · 云端抓取 + AI 摘要 → news.json
 *
 * 跑在 GitHub Actions 上（每 30 分钟一次）。为什么放云端：
 *   · 服务器抓取没有 CORS 限制，而且墙外站点（rsshub 等）也能抓
 *   · 抓取和 AI 摘要在云端做一次，所有设备（手机 / Mac / 任何浏览器）读同一个 news.json
 *   · 手机上不需要中转、不需要 key、不需要象览宿主、打开即秒出
 *
 * 用法：node fetch-news.mjs   （在仓库根目录执行，输出 news.json）
 * 环境变量：
 *   DEEPSEEK_API_KEY  可选。有就调 AI 打摘要/标签；没有就只抓取（摘要字段留空）
 *   AI_BASE / AI_MODEL 可选，默认 https://api.deepseek.com/v1 + deepseek-chat
 *   ENRICH_LIMIT      可选，最多给多少条打 AI 摘要，默认 60
 */
import fs from 'node:fs';
import path from 'node:path';

const SOURCES = JSON.parse(fs.readFileSync(new URL('./sources.json', import.meta.url), 'utf8'));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Xiangxun/1.0';
const AI_BASE = process.env.AI_BASE || 'https://api.deepseek.com/v1';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-chat';
const AI_KEY = process.env.DEEPSEEK_API_KEY || '';
const ENRICH_LIMIT = parseInt(process.env.ENRICH_LIMIT || '60', 10);
const TIMEOUT_MS = 20000;
const MAX_BYTES = 8 * 1024 * 1024;

// ─────────────────────────── 抓取 ───────────────────────────

async function get(url, accept) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': accept || 'application/rss+xml, application/atom+xml, application/json, text/xml, */*' }
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('响应过大');
    return { status: r.status, text: decode(buf, r.headers.get('content-type') || '') };
  } finally { clearTimeout(t); }
}

// 中文源不少是 GBK/GB18030 —— Node 不会自动认，手工转
function decode(buf, ctype) {
  const m = /charset=["']?([\w-]+)/i.exec(ctype || '');
  const cands = [m && m[1], 'utf-8', 'gb18030', 'latin1'].filter(Boolean);
  for (const enc of cands) {
    try {
      const s = new TextDecoder(enc).decode(buf);
      // ⚠️ Node 的 utf-8 解码**不会抛错**，遇到 GBK 字节会塞满 U+FFFD 而不报错 ——
      // 所以必须靠"有没有替换字符"来判断，否则联商网这类 GBK 页面会整片乱码。
      if (enc.toLowerCase() !== 'utf-8' || s.indexOf('\uFFFD') === -1) return s;
    } catch (e) { /* 这个编码不支持，试下一个 */ }
  }
  return buf.toString('utf8');
}

const stripTags = s => String(s || '').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

function pick(block, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!m) return '';
  let v = m[1];
  const cd = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(v);
  if (cd) v = cd[1];
  return stripTags(v);
}

const normTitle = t => String(t || '').toLowerCase().replace(/[\s\p{P}]/gu, '');
const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
const uid = s => { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return 'n' + Math.abs(h).toString(36); };

function parseFeed(text, src) {
  const out = [];
  const items = text.match(/<item[\s>][\s\S]*?<\/item>/gi) || text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const block of items.slice(0, 60)) {
    const title = pick(block, 'title');
    if (!title) continue;
    let link = '';
    const lm = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
    if (lm) link = lm[1]; else link = pick(block, 'link');
    const desc = pick(block, 'description') || pick(block, 'summary') || pick(block, 'content');
    const pub = pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated') || pick(block, 'dc:date');
    let ts = pub ? Date.parse(pub) : 0;
    if (!ts || Number.isNaN(ts)) ts = 0;
    out.push({
      title, link, desc: desc.slice(0, 240), source: src.name, cat: src.cat,
      time: ts || Date.now(), id: uid(normTitle(title) + '|' + domainOf(link))
    });
  }
  return out;
}

// 定制抓取：这些站没有 RSS，抓列表页（与 Mac 上 relay.py 的规则一致）
const SCRAPE = [
  { group: 'hotel', name: '环球旅讯', list: 'https://www.traveldaily.cn/', cat: '酒店',
    re: /href="(\/article\/\d+)"[^>]*>\s*([^<]{6,90})\s*</g },
  { group: 'retail', name: '联商网', list: 'https://www.linkshop.com/news', cat: '零售',
    re: /href="(\/news\/\d+\.shtml)"[^>]*>\s*([^<]{6,80})\s*</g },
  { group: 'retail', name: '赢商网·首店报告', list: 'http://news.winshang.com/list-7006.html', cat: '零售',
    re: /href="(http:\/\/news\.winshang\.com\/html\/\d+\/\d+\.html)"[^>]*>\s*([^<]{6,80})\s*</g },
  { group: 'retail', name: '赢商网·品牌选址', list: 'http://news.winshang.com/list-7008.html', cat: '零售',
    re: /href="(http:\/\/news\.winshang\.com\/html\/\d+\/\d+\.html)"[^>]*>\s*([^<]{6,80})\s*</g },
  { group: 'movie', name: '时光网', list: 'https://news.mtime.com/', cat: '电影',
    re: /href="(https:\/\/content\.mtime\.com\/article\/\d+)"[^>]*>\s*([^<]{6,90})\s*</g },
];

async function scrape(src, baseTime) {
  const { text } = await get(src.list, 'text/html,*/*');
  const out = []; const seen = new Set();
  let m; src.re.lastIndex = 0;
  while ((m = src.re.exec(text)) !== null && out.length < 40) {
    const link = new URL(m[1], src.list).href;
    const title = stripTags(m[2]);
    if (title.length < 6 || seen.has(link)) continue;
    seen.add(link);
    out.push({ title, link, desc: src.name, source: src.name, cat: src.cat,
      time: baseTime - out.length * 3 * 60000, id: uid(normTitle(title) + '|' + domainOf(link)) });
  }
  return out;
}

// ─────────────────────────── AI 加工 ───────────────────────────

async function aiChat(messages, jsonMode) {
  const body = { model: AI_MODEL, messages, temperature: 0.3, stream: false };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const r = await fetch(`${AI_BASE.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_KEY}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`AI HTTP ${r.status}`);
  const d = await r.json();
  const text = d?.choices?.[0]?.message?.content || '';
  if (!jsonMode) return text;
  try { return JSON.parse(text); } catch (e) { /* 剥围栏再试 */ }
  const s = text.indexOf('{'), e2 = text.lastIndexOf('}');
  if (s >= 0 && e2 > s) { try { return JSON.parse(text.slice(s, e2 + 1)); } catch (e) { } }
  return null;
}

async function enrich(items) {
  if (!AI_KEY) { console.log('（没配 DEEPSEEK_API_KEY，跳过 AI 摘要）'); return; }
  const todo = items.filter(i => !i.summary).slice(0, ENRICH_LIMIT);
  const SIZE = 15;
  for (let i = 0; i < todo.length; i += SIZE) {
    const batch = todo.slice(i, i + SIZE);
    const lines = batch.map((it, k) => `${k + 1}. 标题：${it.title}　摘要：${(it.desc || '').slice(0, 120)}`).join('\n');
    const prompt = `你是新闻编辑。下面是${batch.length}条新闻，请逐条处理，返回 JSON 对象，`
      + `键为序号字符串，值为对象，包含："summary":"2-3句中文摘要"，"tags":["标签1","标签2"]。`
      + `标签从这些里选：科技、财经、国际、生活、社会、体育、娱乐、健康、教育、热点。每条最多 3 个。`
      + `只返回 JSON，不要解释。\n\n${lines}`;
    try {
      const obj = await aiChat([{ role: 'user', content: prompt }], true);
      if (!obj || typeof obj !== 'object') continue;
      batch.forEach((it, k) => {
        const r = obj[String(k + 1)] || obj[k + 1];
        if (!r) return;
        if (r.summary) it.summary = String(r.summary).slice(0, 300);
        if (Array.isArray(r.tags)) it.tags = r.tags.slice(0, 3).map(String);
      });
      console.log(`  AI 批次 ${Math.floor(i / SIZE) + 1}：${batch.length} 条已处理`);
    } catch (e) {
      console.log(`  AI 批次失败：${e.message}`);
    }
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

function mergeDedupe(all) {
  const byKey = new Map();
  for (const it of all) {
    const key = normTitle(it.title).slice(0, 24) || it.id;
    const hit = byKey.get(key);
    if (hit) {
      if (hit.source.indexOf(it.source) < 0) hit.source += ' · ' + it.source;
      if (!hit.summary && it.summary) { hit.summary = it.summary; hit.tags = it.tags; }
    } else byKey.set(key, it);
  }
  return [...byKey.values()].sort((a, b) => (b.time || 0) - (a.time || 0));
}

(async () => {
  const base = Date.now();
  const all = [];
  const results = await Promise.allSettled([
    ...SOURCES.filter(s => s.enabled !== false).map(async s => {
      const { text, status } = await get(s.url);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const items = parseFeed(text, s);
      if (!items.length) throw new Error('解析出 0 条');
      console.log(`✅ ${s.name}（${s.cat}）${items.length} 条`);
      return items;
    }),
    ...SCRAPE.map(async s => {
      const items = await scrape(s, base);
      console.log(`✅ ${s.name}（定制）${items.length} 条`);
      return items;
    })
  ]);
  results.forEach(r => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.log(`❌ ${r.reason && r.reason.message}`);
  });

  const items = mergeDedupe(all).slice(0, 400);   // 手机端够看，也压住体积
  console.log(`\n合并去重后 ${items.length} 条，开始 AI 摘要…`);
  await enrich(items);

  const out = { updated: Date.now(), updatedISO: new Date().toISOString(), count: items.length, items };
  const dest = path.resolve('news.json');
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`\n已写出 ${dest}（${items.length} 条，${(fs.statSync(dest).size / 1024).toFixed(0)} KB，其中 ${items.filter(i => i.summary).length} 条带 AI 摘要）`);
})();

