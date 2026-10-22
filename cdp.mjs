#!/usr/bin/env node
/**
 * cdp.mjs — 复用 capture-login.mjs 启动的 Edge 调试会话（端口默认 9223）。
 *
 * 子命令：
 *   nav <url>            导航
 *   eval "<js>"          执行 JS（await Promise 支持）
 *   click <文本>         点击包含指定文本的可点击元素
 *   probe                导出当前页面表单元素清单（input/textarea/按钮/下拉）
 *   api <子串>           持续监听网络响应，打印匹配子串的响应体 JSON（用于拿 book_id 等）
 *
 * 用途：驱动番茄作家后台网页（建书、建分卷等 API 需要反爬签名、UI 更稳的场景）。
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.argv[2] || 9223);
const cmd = process.argv[3];
const arg = process.argv[4];

async function getPageTarget() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await r.json();
  const page = (list || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("没有找到页面 target（Edge 是否还开着？）");
  return page;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const target = await getPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.addEventListener("message", (ev) => {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")));
  setTimeout(() => reject(new Error("连接超时")), 10000);
});
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

async function evalJs(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error("JS 执行异常: " + (r.exceptionDetails.exception?.description || "unknown"));
  }
  return r.result?.value;
}

switch (cmd) {
  case "nav": {
    await send("Page.navigate", { url: arg });
    await sleep(2500);
    console.log(JSON.stringify({ ok: true, url: await evalJs("location.href") }));
    break;
  }
  case "eval": {
    console.log(JSON.stringify(await evalJs(arg)));
    break;
  }
  case "click": {
    const text = arg;
    const ok = await evalJs(`(() => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
      const els = [...document.querySelectorAll('button, a, [role=button], [class*=btn], [class*=button], span, div')];
      const hit = els.find(e => norm(e.textContent).includes(${JSON.stringify(text)}) && e.offsetParent !== null);
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    console.log(JSON.stringify({ ok, clicked: text }));
    await sleep(1500);
    break;
  }
  case "probe": {
    const info = await evalJs(`(() => {
      const out = { inputs: [], buttons: [], selects: [], textareas: [], labels: [] };
      document.querySelectorAll('input, textarea').forEach(el => {
        out.inputs.push({
          tag: el.tagName,
          type: el.type || '',
          placeholder: el.placeholder || '',
          name: el.name || '',
          id: el.id || '',
          cls: (el.className || '').toString().slice(0, 80),
          visible: el.offsetParent !== null,
        });
      });
      document.querySelectorAll('button, [role=button], [class*=btn], [class*=button]').forEach(el => {
        const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (t) out.buttons.push({ text: t.slice(0, 40), visible: el.offsetParent !== null });
      });
      document.querySelectorAll('select').forEach(el => {
        out.selects.push({ name: el.name || el.id || '', options: [...el.options].map(o => o.textContent.trim()) });
      });
      const h = document.querySelector('h1, h2, h3, [class*=title]');
      out.pageTitle = h ? h.textContent.replace(/\\s+/g,' ').trim().slice(0, 80) : document.title;
      return out;
    })()`);
    console.log(JSON.stringify(info, null, 1));
    break;
  }
  case "api": {
    const needle = arg || "/api/author/";
    const seen = [];
    const onMsg = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.method !== "Network.responseReceived") return;
      const url = m.params?.response?.url || "";
      if (!url.includes(needle)) return;
      const id = m.params.requestId;
      seen.push(url);
      send("Network.getResponseBody", { requestId: id })
        .then((b) => {
          const body = b.base64Encoded
            ? Buffer.from(b.body, "base64").toString("utf8")
            : b.body;
          console.log("URL: " + url);
          console.log("BODY: " + String(body).slice(0, 2000));
          console.log("---");
        })
        .catch(() => {});
    };
    ws.addEventListener("message", onMsg);
    console.log(JSON.stringify({ listening: needle, note: "Ctrl+C 结束；页面操作产生的匹配请求会打印在此" }));
    // 保持进程存活
    await new Promise(() => {});
    break;
  }
  default:
    console.error("用法: node cdp.mjs <端口> <nav|eval|click|probe|api> [参数]");
    process.exit(2);
}
