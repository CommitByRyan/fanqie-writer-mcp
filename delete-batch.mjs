#!/usr/bin/env node
/**
 * delete-batch.mjs — 批量删除章节（重传前置）
 *
 * 用法：
 *   node delete-batch.mjs --book <book_id> --range 9-160 [--dry] [--interval 2000]
 *
 * 按章号范围删除（从 chapter_list 拿 item_id）。断点：delete-progress.json 记录已删章号。
 * 首个删除目标若为已过审章节（如第10章），其成败即探针：失败会立即停止。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://fanqienovel.com";
const AUTH_FILE = path.join(ROOT, "auth.json");
const PROGRESS_FILE = path.join(ROOT, "delete-progress.json");
const LOG_FILE = path.join(ROOT, "delete-log.txt");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";

function argOf(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes("--" + name);

const BOOK = argOf("book", "");
const RANGE = argOf("range", "");
const INTERVAL = Math.max(0, Number(argOf("interval", "2000")));
const DRY = has("dry");

if (!BOOK || !RANGE) {
  console.error("用法: node delete-batch.mjs --book <book_id> --range 9-160 [--dry]");
  process.exit(2);
}

const auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  console.log(s);
  fs.appendFileSync(LOG_FILE, s + "\n");
};

const COMMON = { aid: "2503", app_name: "muye_novel" };
async function api(method, apiPath, params) {
  const flat = { ...COMMON };
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) flat[k] = String(v);
  const qs = new URLSearchParams(flat).toString();
  // 平台约定：公共参数走 query string；POST  additionally 带 body（与网页行为一致）
  const url = `${BASE}${apiPath}?${qs}`;
  const res = await fetch(url, {
    method,
    headers: {
      Cookie: auth.cookie,
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Origin: BASE,
      Referer: `${BASE}/main/writer/book-manage`,
      "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Microsoft Edge";v="126"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      ...(auth.csrfToken ? { "x-secsdk-csrf-token": auth.csrfToken } : {}),
    },
    body: method === "POST" ? new URLSearchParams(flat).toString() : undefined,
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

// 拉全量章节列表（逐卷翻页；chapter_list 不接受空 volume_id）
async function fetchAllChapters() {
  const volData = await api("GET", "/api/author/volume/volume_list/v1", { book_id: BOOK });
  const volumes = volData?.volume_list || [];
  const all = [];
  for (const v of volumes) {
    for (let page = 0; page < 10; page++) {
      const data = await api("GET", "/api/author/chapter/chapter_list/v1", {
        book_id: BOOK,
        volume_id: v.volume_id,
        page_index: page,
        page_count: 100,
        status: 0,
        must_have_correction_feedback: 0,
        need_correction_feedback_num: 1,
        sort: "",
      });
      const items = data?.item_list || [];
      all.push(...items);
      if (items.length < 100) break;
    }
  }
  return all;
}

function parseRange(spec) {
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
  }
  return set;
}

async function main() {
  log(`拉取章节列表（book=${BOOK}）…`);
  const chapters = await fetchAllChapters();
  const byNum = new Map();
  for (const it of chapters) {
    const m = (it.title || "").match(/第(\d+)章/);
    if (m) byNum.set(+m[1], it);
  }
  log(`共 ${chapters.length} 章（可解析章号 ${byNum.size}）`);

  const want = parseRange(RANGE);
  const targets = [...want].filter((n) => byNum.has(n)).sort((a, b) => a - b);
  const missing = [...want].filter((n) => !byNum.has(n)).sort((a, b) => a - b);
  if (missing.length) log(`⚠️ 未找到章号：${missing.join(",")}`);

  let progress = { deleted: {} };
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } catch {}
  }

  const todo = targets.filter((n) => !progress.deleted[n]);
  log(`待删除 ${todo.length} 章（已删 ${targets.length - todo.length}）`);

  if (DRY) {
    for (const n of todo.slice(0, 10)) {
      const it = byNum.get(n);
      console.log(`  第${n}章 ${it.title} | ds=${it.display_status} | id=${it.item_id}`);
    }
    if (todo.length > 10) console.log(`  …等共 ${todo.length} 章`);
    process.exit(0);
  }

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < todo.length; i++) {
    const n = todo[i];
    const it = byNum.get(n);
    try {
      await api("POST", "/api/author/delete_article/v1", { book_id: BOOK, item_id: it.item_id });
      progress.deleted[n] = { item_id: it.item_id, title: it.title, at: new Date().toISOString() };
      ok++;
      log(`✅ 删除 第${n}章 ${it.title}（ds=${it.display_status}）`);
    } catch (e) {
      fail++;
      log(`❌ 删除 第${n}章 ${it.title} 失败：${e.message}`);
      if (e.authish) {
        log("⛔ 鉴权失效，停止。");
        break;
      }
      // 连续失败 3 次即停（可能是平台策略）
      if (fail >= 3) {
        log("⛔ 连续 3 次失败，停止以防误伤。");
        break;
      }
    }
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf8");
    if (i < todo.length - 1 && INTERVAL > 0) await sleep(INTERVAL);
  }
  log(`===== 删除结果：成功 ${ok} / 失败 ${fail} =====`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
