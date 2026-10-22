#!/usr/bin/env node
/**
 * mcp-config.mjs —— 把 fanqie-writer-mcp 注册进任意 MCP 客户端
 *
 * 市面上的 MCP 客户端配置格式并不统一：根键有 mcpServers / servers /
 * context_servers / mcp，文件格式有 JSON / YAML / TOML，命令有字符串也有数组。
 * 手工改最容易出错的地方正是「键名写错但没有任何报错」。
 *
 * 本脚本做三件事：
 *   1. 检测本机装了哪些客户端（按配置路径存在性判断）
 *   2. 把配置写进目标客户端的配置文件（JSON 类自动合并 + 自动备份）
 *   3. 对 YAML / TOML 这类非 JSON 格式，输出可直接粘贴的片段
 *
 * 用法：
 *   node mcp-config.mjs                    列出检测到的客户端
 *   node mcp-config.mjs --all              写入所有检测到的客户端
 *   node mcp-config.mjs --target cursor     写入指定客户端（可逗号分隔多个）
 *   node mcp-config.mjs --all --dry-run     只预览不落盘
 *   node mcp-config.mjs --http             写远程模式（需先启动 --http 服务）
 *   node mcp-config.mjs --port 8787        远程模式端口，默认 8787
 *   node mcp-config.mjs --node <绝对路径>   指定 node 可执行文件（PATH 解析失败时用）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(HERE, "server.js");
const SERVER_NAME = "fanqie-writer";

// HOME 优先取环境变量，os.homedir() 兜底。
// Windows 下 os.homedir() 读的是 USERPROFILE 而非 HOME，取环境变量可让行为可预期、可测试。
const HOME = process.env.HOME || os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");

/**
 * 客户端登记表。
 * rootKey —— 该客户端配置文件的根键名（写错会静默失效）
 * fmt     —— json | yaml | toml
 * paths   —— 各平台配置路径，first 存在者胜出
 */
const CLIENTS = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    rootKey: "mcpServers",
    fmt: "json",
    paths: {
      win32: [path.join(APPDATA, "Claude", "claude_desktop_config.json")],
      darwin: [path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json")],
      linux: [path.join(HOME, ".config", "Claude", "claude_desktop_config.json")],
    },
    note: "改完需完全退出并重启 Claude Desktop",
  },
  {
    id: "claude-code",
    name: "Claude Code（CLI）",
    rootKey: "mcpServers",
    fmt: "json",
    paths: {
      win32: [path.join(HOME, ".claude.json")],
      darwin: [path.join(HOME, ".claude.json")],
      linux: [path.join(HOME, ".claude.json")],
    },
    note: "也可用 `claude mcp add --scope user fanqie-writer -- node <server.js>`",
  },
  {
    id: "cursor",
    name: "Cursor",
    rootKey: "mcpServers",
    fmt: "json",
    paths: {
      win32: [path.join(HOME, ".cursor", "mcp.json")],
      darwin: [path.join(HOME, ".cursor", "mcp.json")],
      linux: [path.join(HOME, ".cursor", "mcp.json")],
    },
    note: "全局配置在 ~/.cursor/mcp.json；项目级为 <项目>/.cursor/mcp.json",
  },
  {
    id: "vscode",
    name: "VS Code（Copilot）",
    rootKey: "servers",
    fmt: "json",
    paths: {
      win32: [path.join(HOME, ".vscode", "mcp.json")],
      darwin: [path.join(HOME, ".vscode", "mcp.json")],
      linux: [path.join(HOME, ".vscode", "mcp.json")],
    },
    note: "VS Code 根键是 servers 而非 mcpServers；workspace 级为 <项目>/.vscode/mcp.json；portable 格式用 .mcp.json（根键 mcpServers）。需切到 Agent 模式工具才可见",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    rootKey: "mcpServers",
    fmt: "json",
    paths: {
      win32: [path.join(HOME, ".codeium", "windsurf", "mcp_config.json")],
      darwin: [path.join(HOME, ".codeium", "windsurf", "mcp_config.json")],
      linux: [path.join(HOME, ".codeium", "windsurf", "mcp_config.json")],
    },
    note: "",
  },
  {
    id: "cline",
    name: "Cline（VS Code 扩展）",
    rootKey: "mcpServers",
    fmt: "json",
    paths: {
      win32: [
        path.join(
          APPDATA, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings",
          "cline_mcp_settings.json",
        ),
      ],
      darwin: [
        path.join(
          HOME, "Library", "Application Support", "Code", "User", "globalStorage",
          "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json",
        ),
      ],
      linux: [
        path.join(
          HOME, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev",
          "settings", "cline_mcp_settings.json",
        ),
      ],
    },
    note: "",
  },
  {
    id: "roo-code",
    name: "Roo Code（VS Code 扩展）",
    rootKey: "mcpServers",
    fmt: "json",
    paths: {
      win32: [
        path.join(
          APPDATA, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings",
          "mcp_settings.json",
        ),
      ],
      darwin: [
        path.join(
          HOME, "Library", "Application Support", "Code", "User", "globalStorage",
          "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json",
        ),
      ],
      linux: [
        path.join(
          HOME, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline",
          "settings", "mcp_settings.json",
        ),
      ],
    },
    note: "",
  },
  {
    id: "zed",
    name: "Zed",
    rootKey: "context_servers",
    fmt: "json",
    paths: {
      win32: [path.join(APPDATA, "Zed", "settings.json")],
      darwin: [path.join(HOME, "Library", "Application Support", "Zed", "settings.json")],
      linux: [path.join(HOME, ".config", "zed", "settings.json")],
    },
    note: "Zed 根键是 context_servers；旧版格式需把 command 改成 {path,args,env} 对象",
  },
  {
    id: "trae",
    name: "Trae",
    rootKey: "mcpServers",
    fmt: "json",
    paths: {
      win32: [path.join(HOME, ".trae", "mcp.json")],
      darwin: [path.join(HOME, ".trae", "mcp.json")],
      linux: [path.join(HOME, ".trae", "mcp.json")],
    },
    note: "项目级为 <项目>/.trae/mcp.json；Trae 需在设置中开启「项目级 MCP」",
  },
  {
    id: "cherry-studio",
    name: "Cherry Studio",
    rootKey: "mcpServers",
    fmt: "json",
    paths: {
      win32: [path.join(APPDATA, "CherryStudio", "cherry-studio.json")],
      darwin: [path.join(HOME, "Library", "Application Support", "CherryStudio", "cherry-studio.json")],
      linux: [path.join(HOME, ".config", "CherryStudio", "cherry-studio.json")],
    },
    note: "也可在「设置 → MCP 服务器 → 添加」里手动填",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    rootKey: "mcpServers",
    fmt: "json",
    paths: {
      win32: [path.join(HOME, ".gemini", "settings.json")],
      darwin: [path.join(HOME, ".gemini", "settings.json")],
      linux: [path.join(HOME, ".gemini", "settings.json")],
    },
    note: "",
  },
  {
    id: "amazon-q",
    name: "Amazon Q Developer CLI",
    rootKey: "mcpServers",
    fmt: "json",
    paths: {
      win32: [path.join(HOME, ".aws", "amazonq", "mcp.json")],
      darwin: [path.join(HOME, ".aws", "amazonq", "mcp.json")],
      linux: [path.join(HOME, ".aws", "amazonq", "mcp.json")],
    },
    note: "",
  },
  {
    id: "opencode",
    name: "OpenCode",
    rootKey: "mcp",
    fmt: "json",
    shape: "opencode",
    paths: {
      win32: [path.join(LOCALAPPDATA, "opencode", "opencode.json"), path.join(HOME, ".config", "opencode", "opencode.json")],
      darwin: [path.join(HOME, ".config", "opencode", "opencode.json")],
      linux: [path.join(HOME, ".config", "opencode", "opencode.json")],
    },
    note: "OpenCode 根键是 mcp，且 command 为数组",
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    rootKey: "mcpServers",
    fmt: "json",
    paths: {
      win32: [path.join(HOME, ".workbuddy", "mcp.json")],
      darwin: [path.join(HOME, ".workbuddy", "mcp.json")],
      linux: [path.join(HOME, ".workbuddy", "mcp.json")],
    },
    note: "新增自定义 MCP 需在连接器管理页点「信任」后才会生效",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    rootKey: "mcpServers",
    fmt: "json",
    paths: {
      win32: [path.join(HOME, ".lmstudio", "mcp.json")],
      darwin: [path.join(HOME, ".lmstudio", "mcp.json")],
      linux: [path.join(HOME, ".lmstudio", "mcp.json")],
    },
    note: "",
  },
  {
    id: "continue",
    name: "Continue",
    rootKey: "mcpServers",
    fmt: "yaml",
    paths: {
      win32: [path.join(HOME, ".continue", "config.yaml")],
      darwin: [path.join(HOME, ".continue", "config.yaml")],
      linux: [path.join(HOME, ".continue", "config.yaml")],
    },
    note: "Continue 用 YAML 且 mcpServers 是列表格式，需手动粘贴片段",
  },
  {
    id: "codex",
    name: "Codex CLI",
    rootKey: "mcp_servers",
    fmt: "toml",
    paths: {
      win32: [path.join(HOME, ".codex", "config.toml")],
      darwin: [path.join(HOME, ".codex", "config.toml")],
      linux: [path.join(HOME, ".codex", "config.toml")],
    },
    note: "Codex 用 TOML，需手动粘贴片段",
  },
];

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { targets: [], all: false, http: false, port: 8787, dryRun: false, node: "node" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--dry-run" || a === "-n") out.dryRun = true;
    else if (a === "--http") out.http = true;
    else if (a === "--port") { out.port = Number(argv[++i]) || 8787; }
    else if (a === "--node") { out.node = argv[++i] || "node"; }
    else if (a === "--target" || a === "-t") {
      const v = argv[++i] || "";
      out.targets.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function resolvePath(client) {
  const list = client.paths[process.platform] || [];
  for (const p of list) if (fs.existsSync(p)) return p;
  return list[0] || null;
}

function isDetected(client) {
  const p = resolvePath(client);
  return !!(p && fs.existsSync(p));
}

/** 生成该客户端对应的 MCP 服务条目。 */
function buildEntry(client, opts) {
  const url = `http://127.0.0.1:${opts.port}/mcp`;
  if (client.shape === "opencode") {
    return opts.http
      ? { type: "remote", url, enabled: true }
      : { type: "local", command: [opts.node, SERVER_JS], enabled: true };
  }
  if (opts.http) {
    // VS Code 的 type 字段必须显式写 http，否则会被当成 stdio 去拉起进程
    if (client.rootKey === "servers") return { type: "http", url };
    return { type: "http", url };
  }
  if (client.rootKey === "servers") {
    return { type: "stdio", command: opts.node, args: [SERVER_JS] };
  }
  if (client.rootKey === "context_servers") {
    return { command: opts.node, args: [SERVER_JS], env: {} };
  }
  return { command: opts.node, args: [SERVER_JS] };
}

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON：${file}\n  ${e.message}`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** YAML / TOML 客户端：输出可直接粘贴的片段。 */
function buildSnippet(client, opts) {
  const url = `http://127.0.0.1:${opts.port}/mcp`;
  if (client.fmt === "yaml") {
    if (opts.http) {
      return `mcpServers:\n  - name: ${SERVER_NAME}\n    type: streamableHttp\n    url: ${url}\n`;
    }
    return (
      `mcpServers:\n  - name: ${SERVER_NAME}\n    command: ${opts.node}\n` +
      `    args:\n      - ${SERVER_JS}\n`
    );
  }
  if (client.fmt === "toml") {
    if (opts.http) {
      return `[mcp_servers.${SERVER_NAME}]\ntype = "streamableHttp"\nurl = "${url}"\n`;
    }
    return (
      `[mcp_servers.${SERVER_NAME}]\ncommand = "${opts.node}"\n` +
      `args = ["${SERVER_JS.replace(/\\/g, "\\\\")}"]\n`
    );
  }
  return "";
}

function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, bak);
  return bak;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(
      [
        "mcp-config —— 把 fanqie-writer-mcp 注册进任意 MCP 客户端",
        "",
        "  node mcp-config.mjs                  列出检测到的客户端",
        "  node mcp-config.mjs --all            写入所有检测到的客户端",
        "  node mcp-config.mjs -t cursor,zed    写入指定客户端",
        "  node mcp-config.mjs --all --dry-run   预览改动",
        "  node mcp-config.mjs --all --http      写远程模式（先启动 --http 服务）",
        "  node mcp-config.mjs --port 8787       指定远程端口",
        "  node mcp-config.mjs --node <路径>     指定 node 可执行文件",
        "",
      ].join("\n"),
    );
    return;
  }

  const mode = opts.http ? `远程 HTTP（http://127.0.0.1:${opts.port}/mcp）` : "本地 stdio";

  if (!opts.all && opts.targets.length === 0) {
    process.stdout.write(`\n检测到的 MCP 客户端（${mode}）：\n\n`);
    for (const c of CLIENTS) {
      const p = resolvePath(c);
      const mark = isDetected(c) ? "✓ 已安装" : "· 未检测到";
      process.stdout.write(`  ${mark}  ${c.name}\n`);
      if (p) process.stdout.write(`        ${p}\n`);
    }
    process.stdout.write(
      [
        "",
        "写入全部：node mcp-config.mjs --all",
        "写入指定：node mcp-config.mjs -t cursor,zed,claude-desktop",
        "",
      ].join("\n"),
    );
    return;
  }

  const targets = opts.all
    ? CLIENTS.filter(isDetected)
    : CLIENTS.filter((c) => opts.targets.some((t) => t.toLowerCase() === c.id.toLowerCase()));

  if (targets.length === 0) {
    process.stderr.write("没有匹配到目标客户端。已支持的 id：\n");
    process.stderr.write("  " + CLIENTS.map((c) => c.id).join(", ") + "\n");
    process.exit(1);
  }

  process.stdout.write(`\n写入模式：${mode}\n\n`);
  let done = 0;
  let skipped = 0;

  for (const c of targets) {
    const file = resolvePath(c);
    if (!file) {
      process.stdout.write(`  ○ ${c.name}：无已知配置路径，跳过\n`);
      skipped++;
      continue;
    }

    if (c.fmt !== "json") {
      const snippet = buildSnippet(c, opts);
      process.stdout.write(`  ◇ ${c.name}：${c.fmt.toUpperCase()} 格式，需手动粘贴到 ${file}\n`);
      process.stdout.write(
        snippet
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => `      ${l}`)
          .join("\n") + "\n",
      );
      if (c.note) process.stdout.write(`      提示：${c.note}\n`);
      skipped++;
      continue;
    }

    const entry = buildEntry(c, opts);

    if (opts.dryRun) {
      const cur = readJsonSafe(file);
      const next = { ...cur, [c.rootKey]: { ...(cur[c.rootKey] || {}), [SERVER_NAME]: entry } };
      process.stdout.write(`  ◇ ${c.name}（预览）→ ${file}\n`);
      process.stdout.write(
        JSON.stringify({ [c.rootKey]: { [SERVER_NAME]: entry } }, null, 2)
          .split("\n")
          .map((l) => `      ${l}`)
          .join("\n") + "\n",
      );
      void next;
      skipped++;
      continue;
    }

    try {
      const cur = readJsonSafe(file);
      const bak = backupFile(file);
      const next = { ...cur, [c.rootKey]: { ...(cur[c.rootKey] || {}), [SERVER_NAME]: entry } };
      writeJson(file, next);
      process.stdout.write(`  ✓ ${c.name} → ${file}\n`);
      if (bak) process.stdout.write(`      已备份：${bak}\n`);
      if (c.note) process.stdout.write(`      提示：${c.note}\n`);
      done++;
    } catch (e) {
      process.stdout.write(`  ✗ ${c.name}：${e.message}\n`);
      skipped++;
    }
  }

  process.stdout.write(`\n完成：写入 ${done} 个，跳过/需手动 ${skipped} 个。\n`);
  if (done > 0) {
    process.stdout.write("请重启对应客户端使配置生效。\n");
  }
}

main();
