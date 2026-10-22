#!/usr/bin/env node
/**
 * chapter-ui.mjs — 章节管理页 UI 自动化（单脚本全包：启动 Edge → 操作 → 退出）
 *
 * 用法：
 *   node chapter-ui.mjs probe --book <book_id>
 *   node chapter-ui.mjs move <from> <to> --book <book_id>   把第 from 章拖到第 to 章位置（若 UI 支持拖拽）
 *
 * book_id 也可用环境变量 FANQIE_BOOK_ID 提供。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9223;
const PROFILE_DIR = path.join(ROOT, ".browser-profile");
const _args = process.argv.slice(2);
const _bi = _args.indexOf("--book");
const BOOK = (_bi >= 0 ? _args[_bi + 1] : process.env.FANQIE_BOOK_ID) || "";
if (!BOOK) {
  console.error("缺少 book_id：node chapter-ui.mjs <probe|move> [参数] --book <book_id>（或设 FANQIE_BOOK_ID）");
  process.exit(2);
}
const URL_ = `https://fanqienovel.com/main/writer/chapter-manage/${BOOK}`;
const MODE = _args.find((a) => a === "probe" || a === "move") || "probe";
const FROM = Number(_args[_args.indexOf("move") + 1] || 0);
const TO = Number(_args[_args.indexOf("move") + 2] || 0);

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

const edge = findEdge();
if (!edge) {
  console.error("未找到 Edge");
  process.exit(2);
}

console.log("[1/4] 启动 Edge…");
const child = spawn(
  edge,
  [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`, "--no-first-run", "--no-default-browser-check", "--new-window", URL_],
  { detached: false, stdio: "ignore" },
);

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    target = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  } catch {}
  if (!target) await sleep(500);
}
if (!target) {
  console.error("连不上 Edge");
  try { child.kill(); } catch {}
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
console.log("[2/4] 等待章节管理页加载…");
await send("Page.navigate", { url: URL_ });
await sleep(9000);

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "JS error");
  return r.result?.value;
};

if (MODE === "probe") {
  console.log("[3/4] 探查表格结构…");
  const out = await evalJs(`(() => {
    const res = { headers: [], opHtml: [], dragHints: [], pageText: '' };
    document.querySelectorAll('th').forEach(th => res.headers.push((th.textContent||'').trim()));
    const rows = [...document.querySelectorAll('tr.arco-table-tr')];
    for (const row of rows.slice(0, 2)) {
      const tds = row.querySelectorAll('td');
      const last = tds[tds.length-1];
      res.opHtml.push(last ? last.outerHTML.slice(0, 800) : null);
    }
    // 拖拽线索
    document.querySelectorAll('[class*=drag],[class*=handle],[class*=move],[class*=sort],[draggable]').forEach(el => {
      res.dragHints.push({ tag: el.tagName, cls: (el.className||'').toString().slice(0,80) });
    });
    res.pageText = document.body.innerText.replace(/\\s+/g,' ').slice(0, 200);
    res.rowCount = rows.length;
    return res;
  })()`);
  console.log(JSON.stringify(out, null, 1));
} else if (MODE === "move") {
  if (!FROM || !TO) {
    console.error("用法: node chapter-ui.mjs move <from章号> <to章号>");
    process.exit(2);
  }
  console.log(`[3/4] 尝试把第${FROM}章移动到第${TO}章位置…`);
  // 1) 找两章的行元素与坐标
  const geo = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('tr.arco-table-tr')];
    const find = (n) => rows.find(r => new RegExp('第' + n + '章[\\\\s\\\\S]').test((r.textContent||'').replace(/\\s+/g,' '))));
    const r1 = find(${FROM}), r2 = find(${TO});
    if (!r1 || !r2) return { error: 'row-not-found', from: !!r1, to: !!r2, total: rows.length };
    const b1 = r1.getBoundingClientRect(), b2 = r2.getBoundingClientRect();
    return { from: { x: b1.x + 30, y: b1.y + b1.height/2 }, to: { x: b2.x + 30, y: b2.y + b2.height/2 }, rowsVisible: rows.length };
  })()`);
  console.log("   坐标:", JSON.stringify(geo));
  if (geo.error) {
    console.error("未找到目标行（可能需要翻页/搜索）");
    process.exit(3);
  }
  // 2) 真实鼠标拖拽
  const mouse = (type, x, y, button = "left") =>
    send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: 1 });
  await mouse("mousePressed", geo.from.x, geo.from.y);
  await sleep(120);
  // 分多步移动，模拟真实拖拽
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = geo.from.x + ((geo.to.x - geo.from.x) * i) / steps;
    const y = geo.from.y + ((geo.to.y - geo.from.y) * i) / steps;
    await mouse("mouseMoved", x, y);
    await sleep(40);
  }
  await sleep(200);
  await mouse("mouseReleased", geo.to.x, geo.to.y);
  await sleep(2500);
  // 3) 验证顺序
  const after = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('tr.arco-table-tr')];
    const nums = rows.slice(0, 12).map(r => {
      const m = (r.textContent||'').replace(/\\s+/g,' ').match(/第(\\d+)章/);
      return m ? +m[1] : -1;
    });
    return nums;
  })()`);
  console.log("[4/4] 拖拽后前12行章号:", JSON.stringify(after));
  console.log(after[0] === FROM ? "⚠️ 第" + FROM + "章仍在首位（表格按发布时间排序，属正常）；请以阅读顺序为准复核" : "顺序有变化，需复核");
} else {
  console.error("未知模式:", MODE);
  process.exit(2);
}

// 清理
try {
  ws.close();
} catch {}
try {
  child.kill();
} catch {}
process.exit(0);
