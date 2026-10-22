#!/usr/bin/env node
/**
 * capture-write-token.mjs — 捕获番茄写接口（POST）用的 x-secsdk-csrf-token
 *
 * 原理：读接口只要 Cookie；写接口（new_article/publish_article）返回空 200，
 * 说明缺 CSRF。本脚本启动 Edge → 注入 fetch/XHR 钩子 → 用 JS 点击页面
 * 「创建章节」按钮 → 截获页面自己发出的 new_article POST 请求头 → 把
 * x-secsdk-csrf-token 写进 auth.json。
 *
 * 用法：node capture-write-token.mjs [端口]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 9223);
const PROFILE_DIR = path.join(ROOT, ".browser-profile");
const AUTH_FILE = path.join(ROOT, "auth.json");
const TARGET_URL = "https://fanqienovel.com/main/writer/book-manage";

function findEdge() {
  const cands = [
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"),
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, "Microsoft/Edge/Application/msedge.exe"),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (s) => (!s ? "(空)" : s.slice(0, 6) + "***" + s.slice(-4));

const HOOK = `
window.__cap = [];
function capHeaders(h) {
  const out = {};
  if (!h) return out;
  try {
    if (h.forEach) h.forEach((v, k) => { out[k] = String(v); });
    else for (const k of Object.keys(h)) out[k] = String(h[k]);
  } catch (e) {}
  return out;
}
const of = window.fetch;
window.fetch = function (...args) {
  try {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    let headers = {};
    if (args[0] && args[0].headers) headers = capHeaders(args[0].headers);
    if (args[1] && args[1].headers) headers = Object.assign(headers, capHeaders(args[1].headers));
    window.__cap.push({ url, method: (args[1] && args[1].method) || 'GET', headers });
  } catch (e) {}
  return of.apply(this, args);
};
const oOpen = XMLHttpRequest.prototype.open;
const oSet = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.open = function (m, u) {
  this.__capH = {}; this.__capU = u; this.__capM = m;
  return oOpen.apply(this, arguments);
};
XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
  try { if (this.__capH) this.__capH[k] = String(v); } catch (e) {}
  return oSet.apply(this, arguments);
};
const oSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (...args) {
  try {
    if (this.__capU) window.__cap.push({ url: String(this.__capU), method: this.__capM || 'GET', headers: this.__capH || {} });
  } catch (e) {}
  return oSend.apply(this, args);
};
true;
`;

const edge = findEdge();
if (!edge) {
  console.error("错误：未找到 Edge。");
  process.exit(2);
}
console.log("[1/4] 启动 Edge…");
const child = spawn(
  edge,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    TARGET_URL,
  ],
  { detached: true, stdio: "ignore" },
);
child.unref();

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await r.json();
    target = (list || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  } catch {}
  if (!target) await sleep(500);
}
if (!target) {
  console.error("错误：连不上 Edge。");
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
const pend = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pend.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener("message", (ev) => {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (m.id != null && pend.has(m.id)) {
    const p = pend.get(m.id);
    pend.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", () => reject(new Error("WS 失败")));
  setTimeout(() => reject(new Error("WS 超时")), 15000);
});

await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
console.log("[2/4] 导航并等待页面就绪…");
await send("Page.navigate", { url: TARGET_URL });
await sleep(6000);

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.value;
};

console.log("[3/4] 点击「创建章节」按钮，触发写接口…");
const clicked = await evalJs(`(() => {
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
  const els = [...document.querySelectorAll('button, a, [role=button], span, div')];
  const hit = els.find(e => norm(e.textContent) === '创建章节' && e.offsetParent !== null);
  if (!hit) return 'not-found';
  hit.click();
  return 'clicked';
})()`);
console.log("   点击结果:", clicked);
await sleep(5000);

// 有些页面点「创建章节」只是开模态框，需要再点一次「创建/确定」
const clicked2 = await evalJs(`(() => {
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
  const els = [...document.querySelectorAll('button, a, [role=button]')];
  const hit = els.find(e => /^(创建|确定|新建|创建章节)$/.test(norm(e.textContent)) && e.offsetParent !== null);
  if (!hit) return 'none';
  hit.click();
  return 'clicked:' + norm(hit.textContent);
})()`);
console.log("   二次点击:", clicked2);
await sleep(5000);

const cap = JSON.parse((await evalJs("JSON.stringify(window.__cap || [])")) || "[]");
console.log(`[4/4] 共记录 ${cap.length} 个请求`);

// 找 new_article 或任何 POST /api/author 请求
let csrf = "";
let found = null;
for (const item of cap) {
  const isAuthor = /\/api\/author\//.test(item.url || "");
  const isPost = (item.method || "GET").toUpperCase() === "POST";
  if (isAuthor && (isPost || /new_article|publish_article/.test(item.url))) {
    const h = item.headers || {};
    const cs = h["x-secsdk-csrf-token"] || h["X-Secsdk-Csrf-Token"] || "";
    console.log(`   POST ${item.url.slice(0, 80)}`);
    console.log(`     headers: ${Object.keys(h).join(", ")}`);
    if (cs && !csrf) {
      csrf = cs;
      found = item;
    }
  }
}

if (!csrf) {
  // 兜底：任何带 csrf 头的请求都行
  for (const item of cap) {
    const h = item.headers || {};
    const cs = h["x-secsdk-csrf-token"] || h["X-Secsdk-Csrf-Token"] || "";
    if (cs) {
      csrf = cs;
      found = item;
      console.log(`   （来自 ${item.url.slice(0, 70)}）`);
      break;
    }
  }
}

if (!csrf) {
  console.error("未捕获到 x-secsdk-csrf-token。页面请求列表：");
  for (const item of cap.slice(0, 20)) console.log("  ", item.method, item.url.slice(0, 90));
  process.exit(3);
}

const auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
auth.csrfToken = csrf;
fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), "utf8");
console.log(`✅ csrfToken 已写入 auth.json：${mask(csrf)}`);
if (found) console.log(`   来源请求：${found.method} ${found.url.slice(0, 90)}`);
process.exit(0);
