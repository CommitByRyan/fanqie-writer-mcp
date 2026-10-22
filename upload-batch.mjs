#!/usr/bin/env node
/**
 * upload-batch.mjs — 番茄小说批量上传（独立脚本，与 fanqie-writer MCP 同一 API 合同）
 *
 * 用法：
 *   node upload-batch.mjs --book <book_id> --volume <volume_id> \
 *       --volume-name "第一卷：默认" --source <稿件目录> \
 *       --range 1-2 --mode publish
 *
 * 参数：
 *   --range      章节号：1-20 / 1,3,5 / all（默认 all）
 *   --mode       draft=存草稿 / publish=提交审核（默认 draft）
 *   --interval   每章间隔毫秒（默认 2000）
 *   --max        本次最多章数（0=不限）
 *   --volumes    分卷映射 "id1|第一卷：丁字巷的缝,id2|第二卷：收屏人,id3|第三卷：照野无夜"
 *               （稿件 chapters.json 的 volume 字段 1/2/3 按顺序映射；不给则全用 --volume）
 *   --dry        只解析不发送
 * 断点：progress.json 记录已成功章号，重跑自动跳过。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://fanqienovel.com";
const AUTH_FILE = path.join(ROOT, "auth.json");
const PROGRESS_FILE = path.join(ROOT, "progress.json");
const LOG_FILE = path.join(ROOT, "upload-log.txt");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";

function argOf(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : dflt;
}
const has = (name) => process.argv.includes("--" + name);

const BOOK = argOf("book", "");
const VOLUME_ID = argOf("volume", "");
const VOLUME_NAME = argOf("volume-name", "正文");
const SOURCE = argOf("source", "");
const RANGE = argOf("range", "all");
const MODE = argOf("mode", "draft");
const INTERVAL = Math.max(0, Number(argOf("interval", "2000")));
const MAX = Math.max(0, Number(argOf("max", "0")));
const DRY = has("dry");

if (!BOOK) {
  console.error("错误：缺少 --book <book_id>");
  process.exit(2);
}
if (!SOURCE) {
  console.error("错误：缺少 --source <稿件目录或 manifest.json>");
  process.exit(2);
}

const auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  console.log(s);
  fs.appendFileSync(LOG_FILE, s + "\n");
};

// ---------- 稿件解析 ----------
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function textToHtml(text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  if (/^\s*<p[\s>]/i.test(t)) return t;
  return t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== "---" && !/^#{1,6}\s/.test(l) && !/^>/.test(l))
    .map((l) => l.replace(/\*\*/g, ""))
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");
}

function parseRange(spec) {
  if (!spec || spec === "all") return null;
  const set = new Set();
  for (const part of String(spec).split(/[,，]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*[-~—]\s*(\d+)$/);
    if (m) {
      const a = Math.min(+m[1], +m[2]);
      const b = Math.max(+m[1], +m[2]);
      for (let i = a; i <= b; i++) set.add(i);
    } else if (/^\d+$/.test(p)) set.add(+p);
    else throw new Error(`无法解析 range 片段「${p}」`);
  }
  return set;
}

// 平台标题规范修正（code=-3007 标题长度不符合规范）：第9章原标题「押」仅一字，
// 番茄要求「第N章 」后缀至少两字，取最小改动「押注」，作者可在网页端再改名。
const TITLE_FIX = { 9: "押注" };

// 分卷映射：--volumes "id1|第一卷：丁字巷的缝,id2|第二卷：收屏人,id3|第三卷：照野无夜"
// 稿件 chapters.json 的 volume 字段（1/2/3）按顺序映射到这些卷。
function parseVolumes(spec) {
  if (!spec) return null;
  return String(spec)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const [id, ...rest] = part.split("|");
      return { volume_id: id.trim(), volume_name: rest.join("|").trim() };
    });
}

function loadChapters(volMap) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(SOURCE, "chapters.json"), "utf8"),
  );
  const arr = (manifest.chapters || []).map((c) => {
    const file = path.resolve(SOURCE, c.file || `chapters/${String(c.number).padStart(4, "0")}.md`);
    const raw = fs.readFileSync(file, "utf8");
    const html = textToHtml(raw);
    const titlePart = TITLE_FIX[c.number] || c.title;
    const vol = volMap && c.volume != null ? volMap[Number(c.volume) - 1] : null;
    return {
      number: c.number,
      title: `第${c.number}章 ${titlePart}`,
      chars: html.replace(/<[^>]+>/g, "").replace(/\s+/g, "").length,
      paragraphs: (html.match(/<p[\s>]/gi) || []).length,
      html,
      file,
      volume_id: vol ? vol.volume_id : VOLUME_ID,
      volume_name: vol ? vol.volume_name : VOLUME_NAME,
    };
  });
  const set = parseRange(RANGE);
  let out = set ? arr.filter((c) => set.has(c.number)) : arr;
  if (MAX > 0) out = out.slice(0, MAX);
  return out;
}

// ---------- API ----------
const COMMON = { aid: "2503", app_name: "muye_novel" };
async function apiPost(apiPath, params) {
  const flat = { ...COMMON };
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) flat[k] = String(v);
  const res = await fetch(BASE + apiPath, {
    method: "POST",
    headers: {
      Cookie: auth.cookie,
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Origin: BASE,
      Referer: `${BASE}/main/writer/book-manage`,
      // 浏览器指纹头：WAF 对 POST 校验，缺失会返回空 200（2026-10-21 实测）
      "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Microsoft Edge";v="126"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      ...(auth.csrfToken ? { "x-secsdk-csrf-token": auth.csrfToken } : {}),
    },
    body: new URLSearchParams(flat).toString(),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  if (j.code !== 0 && j.code !== "0") {
    const e = new Error(`${j.message || j.msg || "未知错误"}（code=${j.code}）`);
    e.code = j.code;
    e.authish = /登录|登陆|csrf|权限|未授权|token|sid/i.test(j.message || "");
    throw e;
  }
  return j.data;
}

// ---------- 主流程 ----------
const chapters = loadChapters(parseVolumes(argOf("volumes", "")));
log(`解析完成：${chapters.length} 章（range=${RANGE}, mode=${MODE}, book=${BOOK}）`);
if (DRY) {
  let total = 0;
  for (const c of chapters) {
    total += c.chars;
    console.log(`  第${c.number}章 ${c.title} | ${c.chars}字 | ${c.paragraphs}段 | 卷:${c.volume_name || "-"}`);
  }
  console.log(`  合计 ${total} 字`);
  process.exit(0);
}

let progress = { done: {}, failed: {} };
if (fs.existsSync(PROGRESS_FILE)) {
  try {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  } catch {}
}

const publishStatus = MODE === "publish" ? 1 : 0;
let ok = 0;
let skip = 0;
let fail = 0;

for (let i = 0; i < chapters.length; i++) {
  const c = chapters[i];
  if (progress.done[c.number]) {
    skip++;
    continue;
  }
  try {
    const draft = await apiPost("/api/author/article/new_article/v0/", {
      book_id: BOOK,
      need_reuse: 0,
    });
    const itemId = draft?.item_id;
    if (!itemId) throw new Error("建草稿未返回 item_id");
    await apiPost("/api/author/publish_article/v0/", {
      item_id: itemId,
      book_id: BOOK,
      title: c.title,
      content: c.html,
      volume_id: c.volume_id,
      volume_name: c.volume_name,
      publish_status: publishStatus,
      need_pay: 0,
      use_ai: 2,
      device_platform: "pc",
      speak_type: 0,
      timer_status: 0,
      timer_time: 0,
      timer_chapter_preview: "[]",
      has_chapter_ad: "false",
      chapter_ad_types: "",
      TerminalType: "web",
      SoftType: "web",
      OperateType: "publish",
    });
    progress.done[c.number] = { item_id: String(itemId), title: c.title, at: new Date().toISOString() };
    ok++;
    log(`✅ 第${c.number}章 ${c.title}（${c.chars}字）→ item ${itemId} [${c.volume_name}]`);
  } catch (e) {
    fail++;
    progress.failed[c.number] = e.message;
    log(`❌ 第${c.number}章 ${c.title}：${e.message}`);
    if (e.authish) {
      log("⛔ 鉴权失效，停止后续上传。请重新运行 capture-login.mjs 更新 auth.json。");
      break;
    }
  }
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf8");
  if (i < chapters.length - 1 && INTERVAL > 0) await sleep(INTERVAL);
}

log(`===== 结果：成功 ${ok} / 跳过 ${skip} / 失败 ${fail} =====`);
process.exit(fail > 0 && ok === 0 ? 1 : 0);
