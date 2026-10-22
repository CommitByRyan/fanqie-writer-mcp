#!/usr/bin/env node
/**
 * capture-login.mjs — 番茄作家后台登录态抓取器（v3，页面钩子版）
 *
 * v3 策略（前两版踩坑总结）：
 *  1. CDP requestWillBeSent 的 headers 不含 Cookie；完整头在
 *     requestWillBeSentExtraInfo 的顶层 params.headers；
 *  2. 更稳的做法：Page.addScriptToEvaluateOnNewDocument 在页面脚本前注入
 *     fetch/XHR 钩子，直接记录页面自己发出的 /api/author 请求头
 *     （Cookie + x-secsdk-csrf-token 原样拿到）；
 *  3. Network.getCookies 作为 Cookie 兜底（含 httpOnly）。
 *
 * 用法：node capture-login.mjs [端口] [打开地址]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 9223);
const PROFILE_DIR = path.join(ROOT, ".browser-profile");
const AUTH_FILE = path.join(ROOT, "auth.json");
const TARGET_URL =
  process.argv[3] || "https://fanqienovel.com/main/writer/book-manage";
const WAIT_MS = Number(process.env.CAPTURE_WAIT_MS || 60000);

function findEdge() {
  const cands = [
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"),
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, "Microsoft/Edge/Application/msedge.exe"),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Microsoft/Edge/Application/msedge.exe"),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (s) => (!s ? "(空)" : s.length <= 12 ? s.slice(0, 3) + "***" : s.slice(0, 6) + "***" + s.slice(-4));

const edge = findEdge();
if (!edge) {
  console.error("错误：未找到 Microsoft Edge。");
  process.exit(2);
}

console.log(`[1/4] 启动 Edge（端口 ${PORT}，持久化 profile）…`);
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

// 页面脚本前注入的钩子：记录页面自己发出的 /api/author 请求头
const HOOK = `
window.__cap = [];
function capHeaders(h) {
  const out = {};
  if (!h) return out;
  try {
    if (h.forEach) h.forEach((v, k) => { out[k] = v; });
    else for (const k of Object.keys(h)) out[k] = h[k];
  } catch (e) {}
  return out;
}
const of = window.fetch;
window.fetch = function (...args) {
  try {
    let url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    let headers = capHeaders(args[1] && args[1].headers);
    if (args[0] && args[0].headers && !args[1]) headers = capHeaders(args[0].headers);
    if (url.indexOf('/api/author/') !== -1) window.__cap.push({ url, headers });
  } catch (e) {}
  return of.apply(this, args);
};
const oOpen = XMLHttpRequest.prototype.open;
const oSet = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.open = function (m, u) {
  this.__capH = {}; this.__capU = u;
  return oOpen.apply(this, arguments);
};
XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
  try { if (this.__capH) this.__capH[k] = v; } catch (e) {}
  return oSet.apply(this, arguments);
};
const oSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (...args) {
  try {
    if (this.__capU && String(this.__capU).indexOf('/api/author/') !== -1) {
      window.__cap.push({ url: String(this.__capU), headers: this.__capH || {} });
    }
  } catch (e) {}
  return oSend.apply(this, args);
};
true;
`;

async function getPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = (list || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  return null;
}

const target = await getPageTarget();
if (!target) {
  console.error("错误：30 秒内未连上 Edge 调试端口。");
  process.exit(2);
}
console.log("[2/4] 已连接 Edge，注入请求钩子…");

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
  ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")));
  setTimeout(() => reject(new Error("连接超时")), 15000);
});

await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
await send("Network.enable");

console.log(`[3/4] 导航到 ${TARGET_URL}（已登录则自动触发接口）…`);
await send("Page.navigate", { url: TARGET_URL });

async function readCap() {
  const r = await send("Runtime.evaluate", {
    expression: "JSON.stringify(window.__cap || [])",
    returnByValue: true,
  });
  try {
    return JSON.parse(r.result?.value || "[]");
  } catch {
    return [];
  }
}

let cap = [];
const deadline = Date.now() + WAIT_MS;
while (Date.now() < deadline) {
  await sleep(2000);
  cap = await readCap();
  if (cap.length) break;
}

if (!cap.length) {
  console.error(`错误：${WAIT_MS / 1000}s 内页面没有发出 /api/author 请求。`);
  console.error("      请确认 Edge 窗口已登录并停留在作家后台页面，然后重跑本脚本。");
  process.exit(3);
}

// 从钩子记录里找带头信息的请求
let cookie = "";
let csrf = "";
let apiUrl = "";
let msToken = "";
let aBogus = "";
for (const item of cap) {
  const h = item.headers || {};
  const ck = h.Cookie || h.cookie || "";
  const cs = h["x-secsdk-csrf-token"] || h["X-Secsdk-Csrf-Token"] || "";
  if (ck && !cookie) {
    cookie = ck;
    apiUrl = item.url;
    try {
      const u = new URL(item.url);
      msToken = u.searchParams.get("msToken") || "";
      aBogus = u.searchParams.get("a_bogus") || "";
    } catch {}
  }
  if (cs && !csrf) csrf = cs;
}

// 兜底：钩子没拿到 Cookie 时用 Network.getCookies 组装
if (!cookie) {
  try {
    const cr = await send("Network.getCookies");
    const fq = (cr.cookies || []).filter((c) => /fanqienovel/.test(c.domain));
    cookie = fq.map((c) => `${c.name}=${c.value}`).join("; ");
    console.log(`（钩子未含 Cookie，已用 getCookies 组装 ${fq.length} 个）`);
  } catch {}
}

if (!cookie) {
  console.error("错误：未能获取 Cookie。");
  process.exit(3);
}

let existing = {};
if (fs.existsSync(AUTH_FILE)) {
  try {
    existing = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch {}
}
const next = {
  ...existing,
  cookie,
  csrfToken: csrf || existing.csrfToken || "",
  msToken: msToken || existing.msToken || "",
  aBogus: aBogus || existing.aBogus || "",
};
fs.writeFileSync(AUTH_FILE, JSON.stringify(next, null, 2), "utf8");

console.log("[4/4] ✅ auth.json 已写入");
console.log(`   cookie  = ${mask(cookie)}（${cookie.length} 字符，来自 ${apiUrl.slice(0, 60)}）`);
console.log(`   csrf    = ${mask(csrf)}`);
console.log(`   msToken = ${mask(msToken)}`);
if (!csrf) {
  console.log("   ⚠️ 未捕获到 x-secsdk-csrf-token（该页面请求可能不带它）。");
  console.log("      若后续接口报鉴权错，请在 Edge 里 F12 → Network → 任选 /api/author 请求，");
  console.log("      把请求头 x-secsdk-csrf-token 手动补进 auth.json 的 csrfToken 字段。");
}
process.exit(csrf ? 0 : 5);
