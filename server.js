#!/usr/bin/env node
/**
 * fanqie-writer-mcp —— 番茄小说作家后台 MCP 服务（零依赖）
 *
 * 目标：解决网页端一次只能传一章的问题，支持从本地稿件目录批量上传。
 *
 * 鉴权：Cookie + x-secsdk-csrf-token（登录 fanqienovel.com 作家后台后，
 *       F12 → Network → 任选一个 /api/author 请求复制两项请求头）。
 *       优先读环境变量 FANQIE_COOKIE / FANQIE_CSRF_TOKEN，
 *       否则读本目录 auth.json（见 auth.json.example）。
 *
 * 传输：默认 stdio（换行分隔 JSON-RPC 2.0）；加 --http <port> 时额外监听
 *       Streamable HTTP（POST/GET/DELETE /mcp），供 Dify / n8n / 扣子 /
 *       ChatGPT Connectors 等只接受 HTTP 的平台型客户端接入。
 *       两种传输共用同一份工具实现，行为完全一致。
 *
 * 日志：一律走 stderr，stdout 只承载 stdio 传输的 JSON-RPC 报文。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const SERVER_NAME = "fanqie-writer";
const SERVER_VERSION = "1.1.0";
// 协议版本按客户端请求回协商：优先采用客户端发起 initialize 时声明的版本，
// 缺省用最新稳定版。2025-03-26 起支持 Streamable HTTP，2025-06-18 移除批量请求。
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const BASE = "https://fanqienovel.com";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const ROOT = __dirname;
const AUTH_FILE = path.join(ROOT, "auth.json");
const STATE_FILE = path.join(ROOT, "state.json");

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

function loadAuth() {
  let fileAuth = {};
  if (fs.existsSync(AUTH_FILE)) {
    try {
      fileAuth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    } catch (e) {
      throw new Error(`auth.json 解析失败：${e.message}`);
    }
  }
  const cookie = process.env.FANQIE_COOKIE || fileAuth.cookie || "";
  const csrfToken =
    process.env.FANQIE_CSRF_TOKEN || fileAuth.csrfToken || fileAuth.csrf_token || "";
  const msToken = process.env.FANQIE_MS_TOKEN || fileAuth.msToken || "";
  const aBogus = process.env.FANQIE_A_BOGUS || fileAuth.aBogus || fileAuth.a_bogus || "";
  const ua = process.env.FANQIE_UA || fileAuth.userAgent || DEFAULT_UA;
  return { cookie, csrfToken, msToken, aBogus, ua };
}

function requireAuth() {
  const auth = loadAuth();
  // Cookie 必需；csrfToken 可选（实测读接口不需要；写接口若报鉴权错再补）
  if (!auth.cookie) {
    throw new Error(
      "缺少鉴权信息。请登录 https://fanqienovel.com 作家后台，" +
        "F12 → Network → 任选一个 /api/author/... 请求，复制请求头里的 " +
        "Cookie，" +
        "填入本目录 auth.json（参考 auth.json.example），" +
        "或设置环境变量 FANQIE_COOKIE。",
    );
  }
  if (!auth.csrfToken) {
    process.stderr.write("[fanqie-writer] 提示：auth.json 未配 csrfToken，按实测读接口可用处理\n");
  }
  return auth;
}

// ---------------------------------------------------------------------------
// HTTP 客户端（番茄作家后台）
// ---------------------------------------------------------------------------

const COMMON_QS = { aid: "2503", app_name: "muye_novel" };

class FanqieApiError extends Error {
  constructor(apiPath, code, message) {
    super(message);
    this.name = "FanqieApiError";
    this.apiPath = apiPath;
    this.code = code;
    this.authFailed = /登录|登陆|csrf|权限|未授权|token|sid/i.test(message) || code === -100;
  }
}

function buildHeaders(auth, extra = {}) {
  const h = {
    Cookie: auth.cookie,
    "User-Agent": auth.ua,
    Accept: "application/json, text/plain, */*",
    Origin: BASE,
    Referer: `${BASE}/main/writer/`,
    // 浏览器指纹头：平台 WAF 对 POST 校验，缺失会返回空 200（2026-10-21 实测）
    "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Microsoft Edge";v="126"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    ...extra,
  };
  if (auth.csrfToken) h["x-secsdk-csrf-token"] = auth.csrfToken;
  return h;
}

async function apiRequest(method, apiPath, params, auth) {
  const flat = {};
  for (const [k, v] of Object.entries({ ...COMMON_QS, ...params })) {
    if (v !== undefined && v !== null) flat[k] = String(v);
  }
  if (auth.msToken) flat.msToken = auth.msToken;
  if (auth.aBogus) flat.a_bogus = auth.aBogus;

  let url = BASE + apiPath;
  const opts = { method, headers: buildHeaders(auth), signal: AbortSignal.timeout(30000) };

  if (method === "GET") {
    url += "?" + new URLSearchParams(flat).toString();
  } else {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    opts.body = new URLSearchParams(flat).toString();
  }

  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new FanqieApiError(apiPath, -1, `请求超时（30s）：${apiPath}`);
    }
    throw new FanqieApiError(apiPath, -1, `网络错误：${e.message}`);
  }

  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new FanqieApiError(
      apiPath,
      res.status,
      `返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`,
    );
  }
  if (j.code !== 0 && j.code !== "0") {
    const msg = j.message || j.msg || "未知错误";
    throw new FanqieApiError(apiPath, j.code, `${msg}（接口 ${apiPath}，code=${j.code}）`);
  }
  return j.data;
}

const apiGet = (p, params, auth) => apiRequest("GET", p, params, auth);
const apiPost = (p, params, auth) => apiRequest("POST", p, params, auth);

// ---------------------------------------------------------------------------
// 业务封装
// ---------------------------------------------------------------------------

function pickList(data, keys) {
  if (Array.isArray(data)) return data;
  for (const k of keys) {
    if (data && Array.isArray(data[k])) return data[k];
  }
  return [];
}

async function listBooks(auth) {
  const data = await apiGet(
    "/api/author/book/book_list/v0",
    { page_index: 0, page_count: 50 },
    auth,
  );
  return pickList(data, ["book_list", "list", "books"]).map((b) => ({
    book_id: String(b.book_id ?? b.id ?? ""),
    book_name: b.book_name ?? b.title ?? "",
    word_count: b.word_count ?? b.word_num,
    read_count: b.read_count,
    creation_status: b.creation_status ?? b.status,
    raw: b,
  }));
}

async function listVolumes(auth, bookId) {
  const data = await apiGet("/api/author/volume/volume_list/v1", { book_id: bookId }, auth);
  return pickList(data, ["volume_list", "list", "volumes"]).map((v) => ({
    volume_id: String(v.volume_id ?? v.id ?? ""),
    volume_name: v.volume_name ?? v.name ?? "",
    raw: v,
  }));
}

async function listChapters(auth, bookId, volumeId) {
  const data = await apiGet(
    "/api/author/chapter/chapter_list/v1",
    {
      book_id: bookId,
      volume_id: volumeId,
      page_index: 0,
      page_count: 100,
      status: 0,
      must_have_correction_feedback: 0,
      need_correction_feedback_num: 1,
      sort: "",
    },
    auth,
  );
  const arr = pickList(data, ["article_list", "chapter_list", "list", "item_list"]);
  return {
    chapters: arr.map((c) => ({
      item_id: String(c.item_id ?? c.id ?? ""),
      title: c.title ?? c.article_title ?? "",
      display: c.display ?? c.status,
      word_count: c.word_count ?? c.word_num,
    })),
    raw: data,
  };
}

function parseDefaultVolume(data) {
  const volumeId = String(data?.volume_id ?? "");
  let volumeName = "正文";
  try {
    let vd = data?.volume_data;
    if (typeof vd === "string") vd = JSON.parse(vd);
    if (Array.isArray(vd)) {
      const hit = vd.find((v) => String(v.volume_id) === volumeId) ?? vd[0];
      if (hit?.volume_name) volumeName = hit.volume_name;
    } else if (vd && typeof vd === "object" && vd.volume_name) {
      volumeName = vd.volume_name;
    }
  } catch {
    /* 用默认名 */
  }
  return { volumeId, volumeName };
}

async function newDraft(auth, bookId) {
  const data = await apiPost(
    "/api/author/article/new_article/v0/",
    { book_id: bookId, need_reuse: 0 },
    auth,
  );
  const itemId = data?.item_id ?? data?.id;
  if (!itemId) {
    throw new FanqieApiError(
      "/api/author/article/new_article/v0/",
      -1,
      `建草稿未返回 item_id：${JSON.stringify(data).slice(0, 160)}`,
    );
  }
  const { volumeId, volumeName } = parseDefaultVolume(data);
  return { itemId: String(itemId), volumeId, volumeName };
}

async function publishArticle(auth, opts) {
  return apiPost(
    "/api/author/publish_article/v0/",
    {
      item_id: opts.itemId,
      book_id: opts.bookId,
      content: opts.content,
      title: opts.title,
      volume_id: opts.volumeId,
      volume_name: opts.volumeName,
      timer_status: opts.timed ? 1 : 0,
      timer_time: opts.timed ? opts.timerTime : 0,
      publish_status: opts.publishStatus, // 0=草稿 1=提交审核
      need_pay: 0,
      use_ai: 2,
      device_platform: "pc",
      speak_type: 0,
      timer_chapter_preview: "[]",
      has_chapter_ad: "false",
      chapter_ad_types: "",
      TerminalType: "web",
      SoftType: "web",
      OperateType: "publish",
    },
    auth,
  );
}

// ---------------------------------------------------------------------------
// 正文处理
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 纯文本 → 番茄要求的 <p> 段落 HTML。已是 <p> 开头则原样返回。 */
function textToHtml(text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  if (/^\s*<p[\s>]/i.test(t)) return t;
  const paras = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== "---")
    .filter((l) => !/^#{1,6}\s/.test(l))
    .filter((l) => !/^>/.test(l))
    .map((l) => l.replace(/\*\*/g, ""));
  return paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
}

function countParagraphs(html) {
  return (html.match(/<p[\s>]/gi) || []).length;
}

function countChars(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, "").length;
}

function normalizeTitle(title, number) {
  const t = String(title ?? "").trim();
  if (/^第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*章/.test(t)) return t;
  return `第${number}章${t ? " " + t : ""}`;
}

// ---------------------------------------------------------------------------
// 稿件源解析（目录 / manifest）
// ---------------------------------------------------------------------------

function parseRangeSpec(spec) {
  if (!spec || spec === "all" || spec === "*") return null;
  const set = new Set();
  for (const part of String(spec).split(/[,，]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*[-~—]\s*(\d+)$/);
    if (m) {
      const a = Math.min(+m[1], +m[2]);
      const b = Math.max(+m[1], +m[2]);
      for (let i = a; i <= b; i++) set.add(i);
    } else if (/^\d+$/.test(p)) {
      set.add(+p);
    } else {
      throw new Error(`无法解析 range 片段「${p}」，示例：1-20 / 1,3,5-7 / all`);
    }
  }
  return set;
}

function readChapterFile(absPath) {
  if (!fs.existsSync(absPath)) return null;
  return fs.readFileSync(absPath, "utf8");
}

function buildEntry({ number, title, body, volume, source }) {
  const html = textToHtml(body);
  return {
    number: Number(number),
    title: normalizeTitle(title, number),
    volume: volume ?? null,
    source,
    paragraphs: countParagraphs(html),
    chars: countChars(html),
    _html: html,
  };
}

/** 从单个 md 文件解析：首行标题检测 + 正文。 */
function parseMdFile(absPath, fallbackNumber) {
  const text = readChapterFile(absPath);
  if (text == null) throw new Error(`文件不存在：${absPath}`);
  const lines = text.split(/\r?\n/);
  let title = "";
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const m = raw.match(/^#{0,6}\s*(第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*章.*)$/);
    if (m) {
      title = m[1].trim();
      start = i + 1;
    }
    break;
  }
  if (!title) {
    const stem = path.basename(absPath, path.extname(absPath));
    const m = stem.match(/(\d+)/);
    const n = m ? +m[1] : fallbackNumber;
    title = `第${n}章`;
  }
  const numMatch = title.match(/第\s*([0-9零〇一二三四五六七八九十百千万两]+)\s*章/);
  let number = fallbackNumber;
  if (numMatch) {
    const parsed = parseCnNumber(numMatch[1]);
    if (parsed != null) number = parsed;
  }
  return buildEntry({
    number,
    title,
    body: lines.slice(start).join("\n"),
    volume: null,
    source: absPath,
  });
}

function parseCnNumber(s) {
  if (/^\d+$/.test(s)) return +s;
  const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  // 简化：只处理「十/百/千/万」组合与纯数字串
  if (/^[零〇一二两三四五六七八九十百千万]+$/.test(s)) {
    let n = 0, cur = 0;
    for (const ch of s) {
      if (ch in map) cur = map[ch];
      else if (ch === "十") n += (cur || 1) * 10, cur = 0;
      else if (ch === "百") n += (cur || 1) * 100, cur = 0;
      else if (ch === "千") n += (cur || 1) * 1000, cur = 0;
      else if (ch === "万") n = (n + cur) * 10000 || 10000, cur = 0;
    }
    return n + cur;
  }
  return null;
}

/**
 * 解析 source：
 *  - 目录且含 chapters.json + chapters/  → 章节索引式（用 chapters.json 的 number/title/file/volume）
 *  - 目录 → 其下 *.md 按文件名排序
 *  - .json 文件 → manifest（章节索引式 chapters.json 或 [{title,content|file}]）
 *  - .md/.txt 文件 → 单章
 */
function resolveSource(source) {
  const abs = path.resolve(source);
  if (!fs.existsSync(abs)) throw new Error(`source 不存在：${abs}`);
  const st = fs.statSync(abs);

  if (st.isFile()) {
    if (/\.json$/i.test(abs)) return parseManifest(abs);
    return [parseMdFile(abs, 1)];
  }

  // 目录
  const manifestPath = path.join(abs, "chapters.json");
  const chaptersDir = path.join(abs, "chapters");
  if (fs.existsSync(manifestPath) && fs.existsSync(chaptersDir) && fs.statSync(chaptersDir).isDirectory()) {
    return parseManifest(manifestPath);
  }

  const files = fs
    .readdirSync(abs)
    .filter((f) => /\.(md|txt)$/i.test(f))
    .sort((a, b) => {
      const na = (a.match(/(\d+)/) || [])[1];
      const nb = (b.match(/(\d+)/) || [])[1];
      if (na && nb) return +na - +nb;
      return a.localeCompare(b, "zh");
    });
  if (!files.length) throw new Error(`目录下没有 .md/.txt 稿件：${abs}`);
  return files.map((f, i) => parseMdFile(path.join(abs, f), i + 1));
}

function parseManifest(jsonPath) {
  const dir = path.dirname(jsonPath);
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const arr = Array.isArray(raw) ? raw : raw.chapters || raw.items || raw.list;
  if (!Array.isArray(arr)) throw new Error(`manifest 格式不正确（缺 chapters 数组）：${jsonPath}`);

  return arr.map((it, idx) => {
    const number = Number(it.number ?? it.id ?? it.chapter_no ?? idx + 1);
    let body = it.content ?? it.body ?? null;
    const fileField = it.file ?? it.path ?? null;
    if (body == null && fileField) {
      const abs = path.resolve(dir, fileField);
      body = readChapterFile(abs);
      if (body == null) throw new Error(`manifest 引用的文件不存在：${abs}`);
    }
    if (body == null) throw new Error(`manifest 第 ${idx + 1} 项缺少 content/file`);
    // 章节 md 无标题行，正文整篇即 body；若正文首行恰是章节标题则由 build 前剥离
    let title = it.title ?? it.chapter_title ?? "";
    let bodyText = String(body);
    const firstLine = bodyText.split(/\r?\n/).find((l) => l.trim());
    const fm = firstLine && firstLine.trim().match(/^#{0,6}\s*(第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*章.*)$/);
    if (fm && !title) {
      title = fm[1].trim();
      bodyText = bodyText.slice(bodyText.indexOf(firstLine) + firstLine.length);
    }
    return buildEntry({
      number,
      title,
      body: bodyText,
      volume: it.volume ?? it.volume_id ?? null,
      source: fileField ? path.resolve(dir, fileField) : `${jsonPath}#${idx + 1}`,
    });
  });
}

function applyRange(entries, rangeSpec) {
  const set = parseRangeSpec(rangeSpec);
  if (!set) return entries;
  return entries.filter((e) => set.has(e.number));
}

// ---------------------------------------------------------------------------
// 当前书 state
// ---------------------------------------------------------------------------

function getState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function setState(patch) {
  const cur = getState();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...cur, ...patch }, null, 2), "utf8");
}

async function resolveBookId(auth, explicit) {
  if (explicit) {
    setState({ current_book_id: String(explicit) });
    return String(explicit);
  }
  const cur = getState().current_book_id;
  if (cur) return String(cur);
  const books = await listBooks(auth);
  if (!books.length) throw new Error("账号下没有小说，请先在番茄作家后台创建作品，或显式传 book_id");
  if (books.length === 1) return books[0].book_id;
  throw new Error(
    `账号下有 ${books.length} 本小说，请显式传 book_id（可先调 list_books 查看）`,
  );
}

// ---------------------------------------------------------------------------
// 上传核心
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parsePublishTime(s) {
  if (!s) return null;
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) throw new Error(`无法解析 publish_time：${s}`);
  const t = Math.floor(ts / 1000 / 60) * 60;
  if (t * 1000 <= Date.now()) throw new Error("publish_time 必须是未来时间");
  return t;
}

async function uploadOne(auth, opts) {
  const { bookId, entry, publishStatus, volumeId, volumeName, timerTime } = opts;
  const draft = await newDraft(auth, bookId);
  const vid = volumeId || draft.volumeId;
  const vname = volumeName || draft.volumeName;
  const data = await publishArticle(auth, {
    itemId: draft.itemId,
    bookId,
    title: entry.title,
    content: entry._html,
    volumeId: vid,
    volumeName: vname,
    publishStatus,
    timed: timerTime != null,
    timerTime: timerTime ?? 0,
  });
  return { itemId: draft.itemId, volumeId: vid, volumeName: vname, data };
}

// ---------------------------------------------------------------------------
// MCP 工具定义
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "check_auth",
    description:
      "检查番茄作家后台登录态是否有效（读取 auth.json 或环境变量中的 Cookie/CSRF，调一次书单接口验证）。返回账号下的小说数量概览。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      const auth = requireAuth();
      const books = await listBooks(auth);
      return {
        auth: "ok",
        books: books.map((b) => ({ book_id: b.book_id, book_name: b.book_name, word_count: b.word_count })),
      };
    },
  },
  {
    name: "list_books",
    description: "列出账号下所有小说（book_id、书名、字数、状态）。批量上传前先用它拿到 book_id。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      const auth = requireAuth();
      return { books: await listBooks(auth) };
    },
  },
  {
    name: "use_book",
    description: "设置当前操作的 book_id（后续工具不传 book_id 时默认用它）。",
    inputSchema: {
      type: "object",
      properties: { book_id: { type: "string", description: "目标小说 book_id" } },
      required: ["book_id"],
      additionalProperties: false,
    },
    async handler(args) {
      const auth = requireAuth();
      const books = await listBooks(auth);
      const hit = books.find((b) => b.book_id === String(args.book_id));
      if (!hit) throw new Error(`book_id ${args.book_id} 不在账号书单中，请先调 list_books 确认`);
      setState({ current_book_id: hit.book_id });
      return { current_book_id: hit.book_id, book_name: hit.book_name };
    },
  },
  {
    name: "list_volumes",
    description: "列出小说的分卷（volume_id、卷名）。多卷作品批量上传时需要它来做卷映射。",
    inputSchema: {
      type: "object",
      properties: { book_id: { type: "string", description: "可选；默认当前选中书" } },
      additionalProperties: false,
    },
    async handler(args) {
      const auth = requireAuth();
      const bookId = await resolveBookId(auth, args?.book_id);
      return { book_id: bookId, volumes: await listVolumes(auth, bookId) };
    },
  },
  {
    name: "list_chapters",
    description: "列出某分卷下的章节（item_id、标题、状态、字数），用于确认哪些章已上传、避免重复。",
    inputSchema: {
      type: "object",
      properties: {
        book_id: { type: "string", description: "可选；默认当前选中书" },
        volume_id: { type: "string", description: "分卷 id；不传则列出所有分卷的章节" },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const auth = requireAuth();
      const bookId = await resolveBookId(auth, args?.book_id);
      if (args?.volume_id) {
        return { book_id: bookId, ...(await listChapters(auth, bookId, String(args.volume_id))) };
      }
      const volumes = await listVolumes(auth, bookId);
      const out = [];
      for (const v of volumes) {
        try {
          const r = await listChapters(auth, bookId, v.volume_id);
          out.push({ volume_id: v.volume_id, volume_name: v.volume_name, chapters: r.chapters });
        } catch (e) {
          out.push({ volume_id: v.volume_id, volume_name: v.volume_name, error: e.message });
        }
      }
      return { book_id: bookId, volumes: out };
    },
  },
  {
    name: "upload_chapter",
    description:
      "上传单章。内容二选一：① title + content（纯文本，按行分段；也可直接给 <p> HTML）；② file=本地稿件路径（自动解析首行标题）。mode=draft 只存草稿（默认，安全）；mode=publish 提交审核。publish_time 传 ISO 时间则定时发布。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "章节标题，须含「第N章」前缀（缺失会自动补）" },
        content: { type: "string", description: "正文纯文本或 <p> HTML" },
        file: { type: "string", description: "本地稿件路径（与 title/content 二选一）" },
        book_id: { type: "string", description: "可选；默认当前选中书" },
        volume_id: { type: "string", description: "可选；目标分卷 id" },
        volume_name: { type: "string", description: "可选；分卷名（需与 volume_id 一致）" },
        mode: { type: "string", enum: ["draft", "publish"], description: "draft=存草稿（默认）；publish=提交审核" },
        publish_time: { type: "string", description: "可选，ISO 时间（如 2026-06-20T15:00:00+08:00）则定时发布" },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const auth = requireAuth();
      const bookId = await resolveBookId(auth, args?.book_id);

      let entry;
      if (args?.file) {
        entry = parseMdFile(path.resolve(String(args.file)), 1);
        if (args?.title) entry.title = normalizeTitle(args.title, entry.number);
      } else if (args?.content != null) {
        entry = buildEntry({
          number: 1,
          title: args?.title || "第1章",
          body: String(args.content),
          volume: null,
          source: "(inline)",
        });
      } else {
        throw new Error("需要提供 title+content，或 file");
      }
      if (!entry.paragraphs) throw new Error("正文为空（没有有效段落）");

      const publishStatus = args?.mode === "publish" ? 1 : 0;
      const timerTime = parsePublishTime(args?.publish_time);
      const r = await uploadOne(auth, {
        bookId,
        entry,
        publishStatus,
        volumeId: args?.volume_id ? String(args.volume_id) : null,
        volumeName: args?.volume_name ? String(args.volume_name) : null,
        timerTime,
      });
      return {
        success: true,
        book_id: bookId,
        item_id: r.itemId,
        title: entry.title,
        chars: entry.chars,
        paragraphs: entry.paragraphs,
        mode: publishStatus === 1 ? (timerTime ? "定时发布" : "已提交审核") : "草稿",
        volume_id: r.volumeId,
        volume_name: r.volumeName,
      };
    },
  },
  {
    name: "batch_upload",
    description:
      "批量上传章节（核心工具）。source 支持三种：① 作品目录（含 chapters.json + chapters/NNNN.md，自动取标题与分卷号）；② 普通目录（*.md 按文件名排序，首行「第N章 …」作标题）；③ manifest .json。默认 dry_run=true 只返回上传计划（标题/字数/段落数），确认后传 dry_run=false 真正上传。mode 默认 draft 存草稿；publish 才提交审核（审核中不可改）。支持 range（如 1-20）、volume_map（稿件卷号→番茄 volume_id）、限速与失败策略。",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "稿件目录 / chapters.json / manifest .json / 单个 .md 的路径",
        },
        book_id: { type: "string", description: "可选；默认当前选中书" },
        range: { type: "string", description: "章节号范围，如 1-20、1,3,5-7、all（默认 all）" },
        mode: {
          type: "string",
          enum: ["draft", "publish"],
          description: "draft=存草稿（默认）；publish=提交审核",
        },
        dry_run: {
          type: "boolean",
          description: "true=只预览计划不上传（默认）；false=真正执行",
        },
        interval_ms: {
          type: "number",
          description: "每章之间的间隔毫秒数，默认 2000（限速保护，不建议低于 1000）",
        },
        max_chapters: {
          type: "number",
          description: "本次最多上传多少章（0=不限，默认 0）。大书建议分批",
        },
        volume_id: { type: "string", description: "全部章节放进这个分卷（单卷模式）" },
        volume_name: { type: "string", description: "分卷名（与 volume_id 配套）" },
        volume_map: {
          type: "object",
          description:
            '多卷映射：稿件卷号 → {"volume_id":"…","volume_name":"…"}。例如 {"1":{"volume_id":"123","volume_name":"第一卷"}}。未映射的卷落到 volume_id/默认卷',
          additionalProperties: true,
        },
        continue_on_error: {
          type: "boolean",
          description: "单章失败是否继续（默认 true）。鉴权失效时无论如何都会立即停止",
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
    async handler(args) {
      const dryRun = args?.dry_run !== false;
      // dry_run 只做本地解析预览，不要求登录态；真正上传才校验
      const auth = dryRun ? null : requireAuth();
      const mode = args?.mode === "publish" ? "publish" : "draft";
      const interval = Math.max(0, Number(args?.interval_ms ?? 2000));
      const maxChapters = Math.max(0, Number(args?.max_chapters ?? 0));
      const continueOnError = args?.continue_on_error !== false;

      let entries = applyRange(resolveSource(String(args.source)), args?.range);
      if (maxChapters > 0) entries = entries.slice(0, maxChapters);
      if (!entries.length) throw new Error("source 解析后没有匹配的章节（检查 range / 文件）");

      // 去重：同一章号只取第一个
      const seen = new Set();
      entries = entries.filter((e) => (seen.has(e.number) ? false : (seen.add(e.number), true)));

      const bookId = dryRun
        ? args?.book_id
          ? String(args.book_id)
          : (getState().current_book_id || "(dry_run 未解析)")
        : await resolveBookId(auth, args?.book_id);

      const volumeMap = {};
      if (args?.volume_map && typeof args.volume_map === "object") {
        for (const [k, v] of Object.entries(args.volume_map)) {
          volumeMap[String(k)] =
            typeof v === "object" && v
              ? { volume_id: String(v.volume_id ?? ""), volume_name: String(v.volume_name ?? "") }
              : { volume_id: String(v), volume_name: "" };
        }
      }

      const plan = entries.map((e) => {
        const vm = e.volume != null ? volumeMap[String(e.volume)] : null;
        return {
          number: e.number,
          title: e.title,
          chars: e.chars,
          paragraphs: e.paragraphs,
          source: path.basename(e.source),
          volume: e.volume,
          target_volume_id: vm?.volume_id || args?.volume_id || null,
          target_volume_name: vm?.volume_name || args?.volume_name || null,
          ok: e.paragraphs > 0,
          note: e.paragraphs > 0 ? "" : "正文为空",
        };
      });

      const totalChars = plan.reduce((s, p) => s + p.chars, 0);
      const empty = plan.filter((p) => !p.ok);

      if (dryRun) {
        return {
          dry_run: true,
          mode,
          book_id: bookId,
          total: plan.length,
          total_chars: totalChars,
          empty_count: empty.length,
          hint:
            "这是预览，未上传。确认无误后再次调用并传 dry_run=false。" +
            (mode === "publish" ? "publish 模式会立即提交审核，审核中章节不可修改。" : "draft 模式只存草稿，可随时改。"),
          chapters: plan,
        };
      }

      // 真正上传
      const publishStatus = mode === "publish" ? 1 : 0;
      const results = [];
      let stopped = null;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const vm = e.volume != null ? volumeMap[String(e.volume)] : null;
        try {
          const r = await uploadOne(auth, {
            bookId,
            entry: e,
            publishStatus,
            volumeId: vm?.volume_id || args?.volume_id || null,
            volumeName: vm?.volume_name || args?.volume_name || null,
            timerTime: null,
          });
          results.push({
            number: e.number,
            title: e.title,
            status: "ok",
            item_id: r.itemId,
            volume_id: r.volumeId,
            chars: e.chars,
          });
        } catch (err) {
          const isAuth = err instanceof FanqieApiError && err.authFailed;
          results.push({
            number: e.number,
            title: e.title,
            status: "error",
            error: err.message,
            code: err instanceof FanqieApiError ? err.code : undefined,
          });
          if (isAuth) {
            stopped = `鉴权失效，已停止（${e.title}）：${err.message}`;
            break;
          }
          if (!continueOnError) {
            stopped = `按 continue_on_error=false 在《${e.title}》处停止`;
            break;
          }
        }
        if (i < entries.length - 1 && interval > 0) await sleep(interval);
      }

      const okCount = results.filter((r) => r.status === "ok").length;
      const errCount = results.length - okCount;
      return {
        dry_run: false,
        mode,
        book_id: bookId,
        total: entries.length,
        attempted: results.length,
        success: okCount,
        failed: errCount,
        stopped,
        note:
          publishStatus === 1
            ? "已提交审核的章节需等平台审核通过（display=1）后才对外可见，审核中不可修改。"
            : "草稿可在番茄作家后台逐章确认后手动发布，或再次用 upload_chapter/edit 方式提交。",
        results,
      };
    },
  },
  {
    name: "update_chapter",
    description:
      "覆盖更新已存在的章节（按 item_id，来自 list_chapters）。仅草稿可改；已提交审核的章节改不了（平台返回 -3027）。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "章节 item_id" },
        title: { type: "string", description: "新标题（可选）" },
        content: { type: "string", description: "新正文（纯文本或 <p> HTML）" },
        file: { type: "string", description: "新正文从文件读取（与 content 二选一）" },
        book_id: { type: "string", description: "可选；默认当前选中书" },
        volume_id: { type: "string", description: "可选；分卷 id" },
        volume_name: { type: "string", description: "可选；分卷名" },
      },
      required: ["item_id"],
      additionalProperties: false,
    },
    async handler(args) {
      const auth = requireAuth();
      const bookId = await resolveBookId(auth, args?.book_id);
      if (!args?.content && !args?.file) throw new Error("需要提供 content 或 file");

      let body = args.content != null ? String(args.content) : readChapterFile(path.resolve(String(args.file)));
      if (body == null) throw new Error(`文件不存在：${args.file}`);
      const html = textToHtml(body);
      if (!countParagraphs(html)) throw new Error("正文为空");

      let volumeId = args?.volume_id ? String(args.volume_id) : null;
      let volumeName = args?.volume_name ? String(args.volume_name) : null;
      if (!volumeId) {
        // 取该书分卷列表里的第一卷作为默认卷（不要建草稿，避免留下空草稿）
        const vols = await listVolumes(auth, bookId);
        if (!vols.length) throw new Error("该书没有分卷，无法确定 volume_id，请显式传 volume_id");
        volumeId = vols[0].volume_id;
        volumeName = volumeName || vols[0].volume_name || "正文";
      }

      const data = await publishArticle(auth, {
        itemId: String(args.item_id),
        bookId,
        title: args?.title ? normalizeTitle(args.title, 1) : undefined,
        content: html,
        volumeId,
        volumeName: volumeName || "正文",
        publishStatus: 0,
        timed: false,
        timerTime: 0,
      });
      return { success: true, book_id: bookId, item_id: String(args.item_id), data };
    },
  },
  {
    name: "preview_html",
    description: "把纯文本转成番茄正文 HTML（<p> 段落）看效果，不动任何远端数据。用于格式自查。",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "正文纯文本" },
        file: { type: "string", description: "或本地稿件路径" },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const text =
        args?.content != null
          ? String(args.content)
          : readChapterFile(path.resolve(String(args?.file || "")));
      if (text == null) throw new Error("需要提供 content 或 file");
      const html = textToHtml(text);
      return {
        paragraphs: countParagraphs(html),
        chars: countChars(html),
        html_head: html.slice(0, 800),
      };
    },
  },
];

// ---------------------------------------------------------------------------
// MCP 协议核心（传输无关）
// ---------------------------------------------------------------------------

/** 挑选双方都支持的协议版本：客户端声明的版本优先，否则回落到最新稳定版。 */
function negotiateProtocolVersion(requested) {
  if (typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)) return requested;
  return DEFAULT_PROTOCOL_VERSION;
}

async function handleToolCall(params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { content: [{ type: "text", text: `未知工具：${name}` }], isError: true };
  }
  try {
    const result = await tool.handler(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: false,
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `错误：${e.message}` }],
      isError: true,
    };
  }
}

/**
 * 处理一条 JSON-RPC 消息。
 * 返回待发送的响应对象；通知（无 id）返回 null。
 * 该函数不触碰 stdout，stdio 与 HTTP 两种传输共用。
 */
async function handleRpc(msg) {
  const { id, method, params } = msg || {};

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }

  if (
    method === "notifications/initialized" ||
    method === "notifications/cancelled" ||
    method === "notifications/progress" ||
    method === "notifications/roots/list_changed"
  ) {
    return null;
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    };
  }
  if (method === "tools/call") {
    return { jsonrpc: "2.0", id, result: await handleToolCall(params) };
  }
  if (id !== undefined) {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 传输层 A：stdio（默认）
// ---------------------------------------------------------------------------

function startStdio() {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        process.stderr.write(`[fanqie-writer] 非法 JSON 行：${e.message}\n`);
        continue;
      }
      Promise.resolve(handleRpc(msg))
        .then((res) => {
          if (res) process.stdout.write(JSON.stringify(res) + "\n");
        })
        .catch((e) => {
          process.stderr.write(`[fanqie-writer] 处理失败：${e.stack || e.message}\n`);
          if (msg && msg.id !== undefined) {
            process.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32603, message: String(e.message || e) },
              }) + "\n",
            );
          }
        });
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stderr.write(`[fanqie-writer] ${SERVER_NAME} v${SERVER_VERSION} 启动（stdio）\n`);
}

// ---------------------------------------------------------------------------
// 传输层 B：Streamable HTTP
// ---------------------------------------------------------------------------

const sessions = new Map(); // sessionId -> { createdAt, lastSeen }

function makeSessionId() {
  return "fw-" + require("crypto").randomBytes(16).toString("hex");
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function startHttp(port, host) {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // CORS：Streamable HTTP 客户端（浏览器端 Agent、网页版 IDE）需要预检放行
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Authorization");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found", hint: "MCP endpoint is /mcp" }));
      return;
    }

    // 访问令牌：设置 FANQIE_HTTP_TOKEN 后，HTTP 端点要求 Bearer 鉴权。
    // 暴露到局域网或公网时务必设置。
    const httpToken = process.env.FANQIE_HTTP_TOKEN || "";
    if (httpToken) {
      const authHeader = String(req.headers.authorization || "");
      const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (bearer !== httpToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32001, message: "Unauthorized: 需要 Authorization: Bearer <FANQIE_HTTP_TOKEN>" },
          }),
        );
        return;
      }
    }

    const sessionId = req.headers["mcp-session-id"];

    // GET /mcp：建立服务端事件流（本服务无主动推送，保留以兼容 SSE 型客户端）
    if (req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      });
      sseWrite(res, { jsonrpc: "2.0", method: "notifications/initialized" });
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => clearInterval(keepAlive));
      return;
    }

    // DELETE /mcp：终止会话
    if (req.method === "DELETE") {
      if (sessionId) sessions.delete(sessionId);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jsonRpcError(null, -32700, String(e.message))));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jsonRpcError(null, -32700, `parse error: ${e.message}`)));
      return;
    }

    // 通知类消息不回响应体
    if (msg && msg.id === undefined) {
      try {
        await handleRpc(msg);
      } catch (e) {
        process.stderr.write(`[fanqie-writer] 处理失败：${e.stack || e.message}\n`);
      }
      res.writeHead(202);
      res.end();
      return;
    }

    let result;
    try {
      result = await handleRpc(msg);
    } catch (e) {
      process.stderr.write(`[fanqie-writer] 处理失败：${e.stack || e.message}\n`);
      result = jsonRpcError(msg?.id, -32603, String(e.message || e));
    }

    // initialize 时下发会话 ID
    const headers = { "Content-Type": "application/json" };
    if (msg?.method === "initialize" && !sessionId) {
      const sid = makeSessionId();
      sessions.set(sid, { createdAt: Date.now(), lastSeen: Date.now() });
      headers["Mcp-Session-Id"] = sid;
    } else if (sessionId) {
      const s = sessions.get(sessionId);
      if (s) s.lastSeen = Date.now();
    }

    res.writeHead(200, headers);
    res.end(JSON.stringify(result));
  });

  srv.listen(port, host, () => {
    process.stderr.write(
      `[fanqie-writer] ${SERVER_NAME} v${SERVER_VERSION} 启动（HTTP）→ http://${host}:${port}/mcp\n`,
    );
  });
  return srv;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { httpPort: null, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http" || a === "--sse") {
      const nxt = argv[i + 1];
      if (nxt && /^\d+$/.test(nxt)) {
        out.httpPort = Number(nxt);
        i++;
      } else {
        out.httpPort = 8787;
      }
    } else if (a.startsWith("--http=")) {
      out.httpPort = Number(a.slice(7)) || 8787;
    } else if (a === "--host") {
      out.host = argv[i + 1] || "127.0.0.1";
      i++;
    } else if (a.startsWith("--host=")) {
      out.host = a.slice(7);
    } else if (a === "--version" || a === "-v") {
      process.stdout.write(`${SERVER_VERSION}\n`);
      process.exit(0);
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        [
          `fanqie-writer-mcp v${SERVER_VERSION}`,
          "",
          "用法：",
          "  node server.js                以 stdio 传输启动（默认）",
          "  node server.js --http 8787    同时启动 Streamable HTTP（/mcp）",
          "  node server.js --http 0       仅 HTTP 传输，端口随机（回显实际端口）",
          "  node server.js --host 0.0.0.0 --http 8787   允许局域网/容器外访问",
          "",
          "环境变量：",
          "  FANQIE_COOKIE / FANQIE_CSRF_TOKEN   优先于 auth.json 的鉴权来源",
          "  FANQIE_HTTP_TOKEN                   启用后，HTTP 端点需带 Authorization: Bearer <token>",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  startStdio();
  if (opts.httpPort !== null) {
    startHttp(opts.httpPort, opts.host);
  }
}

main();
