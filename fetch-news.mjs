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
 *   ENRICH_LIMIT      可选，最多给多少条**新**新闻打 AI 摘要，默认 60
 *   BODY_LIMIT        可选，一次最多抓多少条正文，默认 = ENRICH_LIMIT
 *
 * 摘要怎么来的（重要）：
 *   1. 先按 id 把**上一次 news.json 里已有的摘要搬过来** —— 只有新文章才花钱；
 *   2. 对新文章**先抓正文**（并发 4、单条 15s、整批 8 分钟预算），去标签截 6000 字，
 *      让模型**只根据正文**写摘要，标 summaryFrom="body"；
 *   3. 抓不到正文的（动态渲染 / 403 / 超时）**退回标题+简介**方式，标 summaryFrom="title"。
 */
import fs from 'node:fs';
import path from 'node:path';

const SOURCES = JSON.parse(fs.readFileSync(new URL('./sources.json', import.meta.url), 'utf8'));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Xiangxun/1.0';
// 抓正文时用这个：很多站点对"不像浏览器"的 UA 直接 403
const BOT_UA = 'XiangxunBot/1.0 (+https://github.com/kenjcha-wq/Xiangxun)';
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

// HTML → 正文纯文本（去脚本样式、尽量只留正文容器、剥标签、解实体）
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style[\s\S]*?<\/style>/gi, ' ')
       .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
       .replace(/<!--[\s\S]*?-->/g, ' ');
  const m = s.match(/<article[\s\S]*?<\/article>/i) || s.match(/<main[\s\S]*?<\/main>/i);
  if (m && m[0].length > 400) s = m[0];
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
       .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  return s.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const BODY_TIMEOUT_MS = 15000;
const BODY_MAX_CHARS = 6000;
const BODY_CONCURRENCY = 4;
const BODY_BUDGET_MS = 8 * 60 * 1000;

async function fetchBody(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), BODY_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal, redirect: 'follow',
      headers: { 'User-Agent': BOT_UA, 'Accept': 'text/html,application/xhtml+xml,text/plain,*/*' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 3 * 1024 * 1024) throw new Error('页面太大');
    const txt = htmlToText(decode(buf, r.headers.get('content-type') || ''));
    if (txt.length < 120) throw new Error('正文太短（可能是动态渲染）');
    return txt.slice(0, BODY_MAX_CHARS);
  } finally { clearTimeout(t); }
}

const TAG_HINT = '科技、财经、国际、生活、社会、体育、娱乐、健康、教育、热点';

async function enrich(items, prev) {
  // ① 先搬上一轮的摘要：id 是稳定哈希，所以只有"新文章"才需要花钱
  let carried = 0;
  if (prev && Array.isArray(prev.items)) {
    const map = new Map();
    for (const p of prev.items) if (p && p.id && p.summary) map.set(p.id, p);
    for (const it of items) {
      const p = map.get(it.id);
      if (p && !it.summary) {
        it.summary = p.summary;
        if (p.tags) it.tags = p.tags;
        it.summaryFrom = p.summaryFrom || 'title';
        carried++;
      }
    }
    if (carried) console.log(`  ♻️  复用上次的 ${carried} 条摘要（不重复花钱）`);
  }

  if (!AI_KEY) { console.log('（没配 DEEPSEEK_API_KEY，跳过 AI 摘要）'); return; }
  const todo = items.filter(i => !i.summary).slice(0, ENRICH_LIMIT);
  if (!todo.length) { console.log('  没有新条目需要摘要'); return; }

  // ② 抓正文（并发 4、单条 15s、整批 8 分钟预算）
  const started = Date.now();
  let okBody = 0, failBody = 0;
  const queue = todo.slice();
  async function worker() {
    while (queue.length) {
      const it = queue.shift();
      if (Date.now() - started > BODY_BUDGET_MS) { it._body = ''; failBody++; continue; }
      try { it._body = await fetchBody(it.link); okBody++; }
      catch (e) { it._body = ''; failBody++; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(BODY_CONCURRENCY, todo.length)) }, worker));
  console.log(`  正文：抓到 ${okBody} 条，抓不到 ${failBody} 条（这些退回标题方式）`);

  // ③ 有正文的：一条一次（正文长，塞一个批次会爆上下文）
  for (const it of todo) {
    if (!it._body) continue;
    const prompt = `下面是一篇新闻的正文（已去掉 HTML）。请用中文写 2-4 句摘要，`
      + `抓住**主要内容、关键数字和结论**，不要复述标题，不要编造正文里没有的信息。`
      + `再给 1-3 个标签（从这些里选：${TAG_HINT}）。`
      + `只返回 JSON，不要解释：{"summary":"...","tags":["..."]}\n\n正文：\n${it._body}`;
    try {
      const obj = await aiChat([{ role: 'user', content: prompt }], true);
      if (obj && obj.summary) {
        it.summary = String(obj.summary).slice(0, 300);
        it.summaryFrom = 'body';
        if (Array.isArray(obj.tags)) it.tags = obj.tags.slice(0, 3).map(String);
      }
    } catch (e) {
      console.log(`  ⚠️ 正文总结失败（${String(it.title).slice(0, 14)}）：${e.message}`);
    }
    delete it._body;
  }

  // ④ 剩下（没正文/正文总结失败）的：还是按原来的批量方式，用标题+简介
  const rest = todo.filter(i => !i.summary);
  const SIZE = 15;
  for (let i = 0; i < rest.length; i += SIZE) {
    const batch = rest.slice(i, i + SIZE);
    const lines = batch.map((it, k) => `${k + 1}. 标题：${it.title}　摘要：${(it.desc || '').slice(0, 120)}`).join('\n');
    const prompt = `你是新闻编辑。下面是${batch.length}条新闻，请逐条处理，返回 JSON 对象，`
      + `键为序号字符串，值为对象，包含："summary":"2-3句中文摘要"，"tags":["标签1","标签2"]。`
      + `标签从这些里选：${TAG_HINT}。每条最多 3 个。`
      + `只返回 JSON，不要解释。\n\n${lines}`;
    try {
      const obj = await aiChat([{ role: 'user', content: prompt }], true);
      if (!obj || typeof obj !== 'object') continue;
      batch.forEach((it, k) => {
        const r = obj[String(k + 1)] || obj[k + 1];
        if (!r) return;
        if (r.summary) { it.summary = String(r.summary).slice(0, 300); it.summaryFrom = 'title'; }
        if (Array.isArray(r.tags)) it.tags = r.tags.slice(0, 3).map(String);
      });
      console.log(`  AI 批次 ${Math.floor(i / SIZE) + 1}：${batch.length} 条已处理（标题方式）`);
    } catch (e) {
      console.log(`  AI 批次失败：${e.message}`);
    }
  }
  const byBody = todo.filter(i => i.summaryFrom === 'body').length;
  console.log(`  ✅ 本轮新摘要：正文方式 ${byBody} 条 / 标题方式 ${todo.filter(i => i.summaryFrom === 'title').length} 条`);
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

// 今日简报：一天只生成一次（复用仓库里已有的 news.json），避免每 30 分钟烧一次
function bjDate(ts) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function makeDigest(items, prev) {
  const today = bjDate(Date.now());
  // ⚠️ 复用要放在"没 key"判断**之前**：今天已经烤好的简报，
  // 不能因为这次没配 key（或临时去掉 key）就被清空。
  if (prev && prev.digest && prev.digestDate === today) {
    console.log(`  ♻️  复用今天的简报（${prev.digestDate}），不再调 AI`);
    return { digest: prev.digest, digestDate: prev.digestDate };
  }
  if (!AI_KEY) return { digest: '', digestDate: '' };
  const top = items.slice(0, 40);
  if (top.length < 3) return { digest: '', digestDate: '' };
  // 有摘要就用摘要（比只喂标题准得多）；没有的退回标题
  const lines = top.map((it, i) => `${i + 1}. [${it.cat || ''}] ${it.title}`
    + (it.summary ? `　摘要：${String(it.summary).slice(0, 90)}` : '')).join('\n');
  const prompt = `今天是 ${today}。你是新闻主编。根据下面今天的新闻（有的带摘要），写一份 300 字左右的中文每日简报，`
    + '按主题聚合（如科技、财经、国际、生活、酒店、零售），每段 2-3 句。不要编造，只基于给的材料。'
    + '开头直接写「每日简报（' + today + '）」这样的日期，不要写"X月X日"这类占位。\n\n' + lines;
  try {
    const text = await aiChat([{ role: 'user', content: prompt }], false);
    console.log('  ✅ 已生成今天的简报');
    return { digest: String(text || '').trim(), digestDate: today };
  } catch (e) {
    console.log('  ⚠️ 简报生成失败：' + e.message);
    return { digest: '', digestDate: '' };
  }
}

(async () => {
  const base = Date.now();
  // 仓库里已有的 news.json（Actions 会 checkout 下来）→ 用来复用简报
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(path.resolve('news.json'), 'utf8')); } catch (e) {}
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
  await enrich(items, prev);

  // 内部字段（_body 之类）绝不能进 news.json
  for (const it of items) {
    for (const k of Object.keys(it)) if (k.startsWith('_')) delete it[k];
  }

  const dg = await makeDigest(items, prev);
  const out = { updated: Date.now(), updatedISO: new Date().toISOString(), count: items.length,
                digest: dg.digest, digestDate: dg.digestDate, items };
  const dest = path.resolve('news.json');
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`\n已写出 ${dest}（${items.length} 条，${(fs.statSync(dest).size / 1024).toFixed(0)} KB，`
    + `其中 ${items.filter(i => i.summary).length} 条带 AI 摘要，简报 ${dg.digest ? '有' : '无'}）`);
})();
