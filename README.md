# fanqie-writer-mcp

番茄小说作家后台 MCP 服务——解决网页端一次只能传一章的问题，支持从本地稿件目录**批量上传**章节。

- 零依赖：单文件 `server.js`，Node.js 直接运行，无需 npm install
- 通用接入：遵循 MCP 标准，**任意兼容 MCP 的 Agent / IDE / 工作流平台**都能接入（stdio 与 Streamable HTTP 双传输）
- 鉴权：复用你自己的浏览器登录态（Cookie + CSRF），不碰账号密码、不绕风控签名
- 默认安全：批量上传先 `dry_run` 出计划，确认后才真正发送；单章默认存草稿

> 使用边界：仅用于上传**你自己拥有版权**的作品到你自己的番茄账号。请遵守番茄平台的内容规范与发布节奏要求（审核、日更限制等）。

## 环境要求与文件清单

- **Node.js ≥ 22.4.0**：capture 登录抓取类脚本依赖全局 `WebSocket`（核心 `server.js` 本身只需 Node 18+ 的 `fetch`）
- **零第三方依赖**：全部脚本仅用 Node 内置模块，clone 后无需 `npm install`

| 文件 | 说明 |
| --- | --- |
| `server.js` | MCP 服务本体（stdio + Streamable HTTP 双传输，零依赖） |
| `mcp-config.mjs` | 通用注册器：检测并写入任意 MCP 客户端的配置 |
| `upload-batch.mjs` | 独立批量上传 CLI（`progress.json` 断点续传，支持 `--volumes` 分卷路由） |
| `delete-batch.mjs` | 独立批量删除 CLI（重传修复前置） |
| `capture-login.mjs` | CDP 启动 Edge 抓登录态，组装完整 Cookie 写入 `auth.json` |
| `capture-write-token.mjs` | 抓 `x-secsdk-csrf-token` 写入 `auth.json` |
| `cdp.mjs` | 手动驱动 Edge 调试会话（nav / eval / click / probe / api） |
| `chapter-ui.mjs` | 章节管理页 UI 自动化（probe 探查 / move 拖拽验证） |
| `auth.json.example` | 鉴权配置模板（复制为 `auth.json` 后填写） |

## 一、首次配置（一次性，约 2 分钟）

1. 浏览器登录 [番茄作家后台](https://fanqienovel.com/main/writer/book-manage)。
2. 按 `F12` 打开开发者工具 → **Network（网络）** 面板。
3. 在后台随便点一下（比如打开作品管理），找到任意一个请求路径以 `/api/author/` 开头的请求。
4. 在该请求的 **Request Headers** 里复制两行：
   - `Cookie:` 整行的值
   - `x-secsdk-csrf-token:` 整行的值
5. 复制 `auth.json.example` 为 `auth.json`，粘贴进去：

```json
{
  "cookie": "sid_guard=...; sessionid=...（整行）",
  "csrfToken": "v1:xxxx=（x-secsdk-csrf-token 的值）",
  "msToken": "",
  "aBogus": "",
  "userAgent": ""
}
```

6. 重启 WorkBuddy（或让 MCP 重连）后，调用工具 `check_auth` 验证。返回 `auth: "ok"` 即成功。

**凭证时效**：Cookie 约 1–2 个月失效（少数网络环境约 24 小时），失效后重复步骤 2–5 更新即可。`msToken` / `aBogus` 可留空（实测作家接口不强制）。

## 二、工具一览

| 工具 | 作用 |
| --- | --- |
| `check_auth` | 验证登录态，返回账号小说数 |
| `list_books` | 列出小说（book_id / 书名 / 字数） |
| `use_book` | 设定当前 book_id |
| `list_volumes` | 列出分卷（volume_id / 卷名） |
| `list_chapters` | 列出章节（item_id / 标题 / 状态 / 字数） |
| `upload_chapter` | 上传单章（draft 草稿 / publish 提交审核 / 可定时） |
| `batch_upload` | **批量上传**（核心，见下） |
| `update_chapter` | 覆盖修改已有草稿（按 item_id） |
| `preview_html` | 本地预览正文转 `<p>` HTML 的效果 |

## 三、批量上传用法（batch_upload）

### source 三种形态

1. **作品目录（灵枢式）**：目录含 `chapters.json` + `chapters/NNNN.md`，自动取 `number`/`title`/`volume` 与 `file` 指向的正文。例：`灵枢作品/ziyeping`。
2. **普通目录**：目录下 `*.md` 按文件名排序；首行「第N章 标题」作标题，否则用文件名里的数字。
3. **manifest JSON**：`[{"title":"第1章 …","file":"a.md"}]` 或 `{"chapters":[…]}`（灵枢 chapters.json 即此类）。

### 推荐流程（以《子夜屏》160 章为例）

```
① check_auth                → 确认登录态
② list_books                → 拿到《子夜屏》的 book_id（网页端先建好空书）
③ list_volumes              → 看已有分卷（三卷的话先在网页端分卷管理里建好）
④ batch_upload
     source=灵枢作品/ziyeping
     book_id=<上一步的>
     range=1-5               → 先试 5 章
     mode=draft
     （默认 dry_run=true，先看计划）
⑤ 确认计划无误 → 同参数再调一次，加 dry_run=false
⑥ 抽查番茄后台草稿箱格式 → 无误后 range=6-52 继续，分批推进
⑦ 全部入库后，再决定是一批批 mode=publish 提交审核，还是在后台手动发
```

### 关键参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `dry_run` | `true` | **只出计划不发送**；确认后传 `false` |
| `mode` | `draft` | `draft`=存草稿（安全）；`publish`=提交审核（审核中不可改） |
| `range` | `all` | 章节号：`1-20` / `1,3,5-7` / `all` |
| `interval_ms` | `2000` | 每章间隔，别低于 1000 |
| `max_chapters` | `0` | 本次上限章数（0=不限），大书建议 20–50 章一批 |
| `volume_map` | — | 多卷映射，如 `{"1":{"volume_id":"…","volume_name":"第一卷"}}`（对应 chapters.json 的 volume 字段） |
| `continue_on_error` | `true` | 单章失败是否继续；鉴权失效必停 |

### 字数与格式硬规则（平台实测）

- 标题必须含「第N章」前缀——工具会自动补齐。
- 正文必须是 HTML `<p>` 段落——工具自动转换（纯文本按行分段，去掉 `**`、`#`、`>` 行）。
- `mode=publish` 后章节进入审核（display=5），**审核中不可修改**（-3027），过审后 display=1。
- 平台对新书/新章节可能有字数与节奏要求（如单章不低于 1000 字），单章过短可能被打回。

### 2026-10-21 上传实战补充（重要）

1. **读接口只要 Cookie**：`book_list` / `volume_list` / `chapter_list` 实测无需 `x-secsdk-csrf-token`。
2. **写接口需要完整浏览器指纹头**：`new_article` / `publish_article` 若缺少 `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform` / `sec-fetch-dest` / `sec-fetch-mode` / `sec-fetch-site` 这组头，平台 WAF 会返回 **HTTP 200 空 body**（极易误判为网络问题）。server.js 与 upload-batch.mjs 已内置。
3. **CSRF 获取**：登录态里任意 secsdk 请求（如 `/ttwid/check/`）的 `x-secsdk-csrf-token` 即为会话级固定值，可直接复用；`capture-write-token.mjs` 会自动抓取并写入 auth.json。
4. **建卷**：`POST /api/author/volume/add_volume/v0`（从页面 JS 常量表挖出，参数 book_id + volume_name，未实测）；改名 `volume/modify/v0`；删卷 `volume/delete_volume/v0/`。
5. **删章节**：`POST /api/author/delete_article/v1`，参数 `book_id` + `item_id`（实测空草稿可删；已过审/审核中章节能否删未验证）。
6. **cookie 组装**：`capture-login.mjs` v3 用 CDP `Network.getCookies` 组装（含 httpOnly 的 sessionid/sid_tt 等 21 个凭证）。
7. **章节排序是平台硬限制**：从页面 JS 提取的完整 API 面（约 200 个端点）中**没有任何章节移动/排序接口**，管理页 UI 也只有编辑/删除。章节顺序 = 创建顺序（index），读者端目录按 index 呈现。**上传必须严格按章号顺序**；第 9 章这类补传章会排在末尾，修复只能删掉其后方所有章节再按序重传（代价是已过审章节回到审核队列）。
8. **标题规范**：`第N章 `后缀至少两字，单字标题报 `-3007 标题长度不符合规范`（第9章「押」→「押注」）。
9. **章节列表响应结构**：`data.item_list[]`，字段 `item_id/index/title/word_number/display_status/article_status/can_delete`；`display_status` 1=已过审、4=审核中；`chapter_list/v1` 的 `status` 参数是过滤（0=全部）。
10. **独立上传脚本**：`upload-batch.mjs` 与 MCP 同一 API 合同，支持 `--range` 分批、`progress.json` 断点续传，适合 MCP 未重连同前的应急上传：
    ```
    node upload-batch.mjs --book <book_id> --volume <volume_id> --volume-name "正文" \
        --source 灵枢作品/ziyeping --range 2-160 --mode publish --interval 2000
    ```
11. **Edge 保活**：bash/PowerShell 工具退出会连带杀掉子进程树里的 Edge；`Start-Process` 与 WMI Create 均不可用（后者被安全策略拦）。需要浏览器跨脚本存活时，用「单脚本全包」模式（launch → 操作 → exit 同脚本内完成）。
12. **分卷上传（2026-10-21 重传实战）**：
    - 建卷 `POST /api/author/volume/add_volume/v0`（book_id + volume_name）。**平台限制「暂不支持创建多个无章节的分卷」**（-4054）——空卷只能有一个，第二个卷要等第一个卷有章节后才能建；
    - 改名 `volume/modify/v0`（volume_data JSON 数组）；
    - `upload-batch.mjs --volumes "id1|第一卷：丁字巷的缝,id2|第二卷：收屏人,id3|第三卷：照野无夜"` 按 chapters.json 的 volume 字段（1/2/3）自动路由；
    - 三卷以上作品的正确姿势：卷1 章节传完 → 建卷2 → 传卷2 → 建卷3 → 传卷3。
13. **删章节（重传修复）**：`delete-batch.mjs --range 9-160`（内部走 `delete_article/v1`）。**已过审章节可删**（152 章全删成功，0 失败），删除后重新上传会回到审核队列。
14. **章节排序是平台硬限制**：见第 7 条——顺序=创建顺序。补传/乱序传的章会排在末尾，修复=删掉其后方所有章节再按序重传（配合分卷映射可一并解决卷结构）。重传前先 `mv progress.json progress-roundN.json` 清掉旧断点，否则脚本会跳过「已传」章节。

## 四、多卷作品（volume_map）

灵枢式 chapters.json 每章带 `volume: 1|2|3`。先在番茄后台「分卷管理」建好分卷（一次性网页操作），然后：

```
batch_upload
  source=灵枢作品/ziyeping
  book_id=…
  volume_map={"1":{"volume_id":"卷ID-1","volume_name":"丁字巷的缝"},
              "2":{"volume_id":"卷ID-2","volume_name":"收屏人"},
              "3":{"volume_id":"卷ID-3","volume_name":"照野无夜"}}
  mode=draft
  max_chapters=30
```

未映射的卷会落到默认卷（`volume_id` 参数或建草稿返回的默认卷）。

## 五、故障排查

| 现象 | 处理 |
| --- | --- |
| `错误：缺少鉴权信息` | 填 `auth.json` 或设环境变量，见「首次配置」 |
| 返回含「登录/csrf」且 code≠0 | Cookie 过期，重新抓一次更新 auth.json |
| `返回非 JSON（HTTP 4xx）` | 多半是 Cookie 过期或触发频控，换网络/稍后重试 |
| 提示 `-3027` | 章节在审核中，改不了，等过审 |
| 正文挤成一段 | 用 `preview_html` 自查；确认原稿是**一行一段**（空行分段两种都支持） |
| 工具没出现 | 检查对应客户端的 MCP 配置是否写对（尤其根键名），改完重启客户端 |

## 六、接入任意 MCP 客户端

本服务遵循 Model Context Protocol 标准，**任何兼容 MCP 的 Agent / IDE / 工作流平台都能接入**，不绑定特定厂商。服务提供两种传输：

| 传输 | 启动方式 | 适用客户端 |
| --- | --- | --- |
| **stdio**（默认） | `node server.js` | 本地客户端：Claude Desktop、Cursor、VS Code、Windsurf、Cline、Roo Code、Zed、Trae、Cherry Studio、Claude Code、Gemini CLI、Codex CLI、Continue、OpenCode、WorkBuddy… |
| **Streamable HTTP** | `node server.js --http 8787` | 平台型 / 远程客户端：Dify、n8n、扣子 Coze、ChatGPT Connectors、OpenAI Agents SDK、自建 Web Agent… |

两种传输共用同一份工具实现，行为完全一致。

### 6.1 最省事：自动注册脚本

```bash
node mcp-config.mjs          # 列出本机检测到的客户端
node mcp-config.mjs --all    # 写入所有检测到的客户端
node mcp-config.mjs -t cursor,zed
```

脚本会按各客户端的**真实根键与路径**写入 JSON 配置，**保留你已有的其它 MCP 配置**，并在覆盖前自动生成 `.bak-时间戳` 备份。Continue（YAML）与 Codex CLI（TOML）不是 JSON 格式，脚本会直接输出可粘贴的片段。

| 参数 | 说明 |
| --- | --- |
| `--all` | 写入所有检测到的客户端 |
| `-t, --target <id>` | 写入指定客户端，逗号分隔 |
| `--dry-run` | 只预览要写入的内容，不落盘 |
| `--http` | 写远程模式条目（需先启动 `--http` 服务） |
| `--port <n>` | 远程模式端口，默认 8787 |
| `--node <路径>` | 指定 node 可执行文件（客户端解析不到 PATH 时用） |

支持的客户端 id：`claude-desktop`、`claude-code`、`cursor`、`vscode`、`windsurf`、`cline`、`roo-code`、`zed`、`trae`、`cherry-studio`、`gemini-cli`、`amazon-q`、`opencode`、`workbuddy`、`lmstudio`、`continue`、`codex`。

### 6.2 手动配置片段

先确认你的客户端用哪种根键——**根键写错不会报错，只是工具不出现**，这是最常见的坑。

| 客户端 | 根键 | 配置位置（Windows / macOS / Linux） |
| --- | --- | --- |
| Claude Desktop | `mcpServers` | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code | `mcpServers` | `~/.claude.json`（或项目根 `.mcp.json`） |
| Cursor | `mcpServers` | `~/.cursor/mcp.json`（项目级 `.cursor/mcp.json`） |
| **VS Code (Copilot)** | **`servers`** | `.vscode/mcp.json`（工作区）/ `~/.vscode/mcp.json`（用户） |
| Windsurf | `mcpServers` | `~/.codeium/windsurf/mcp_config.json` |
| Cline | `mcpServers` | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |
| Roo Code | `mcpServers` | `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json` |
| **Zed** | **`context_servers`** | `%APPDATA%\Zed\settings.json` |
| Trae | `mcpServers` | `~/.trae/mcp.json`（项目级 `.trae/mcp.json`） |
| Cherry Studio | `mcpServers` | `%APPDATA%\CherryStudio\cherry-studio.json` |
| Gemini CLI | `mcpServers` | `~/.gemini/settings.json` |
| Amazon Q | `mcpServers` | `~/.aws/amazonq/mcp.json` |
| **OpenCode** | **`mcp`** | `~/.config/opencode/opencode.json` |
| WorkBuddy | `mcpServers` | `~/.workbuddy/mcp.json` |
| LM Studio | `mcpServers` | `~/.lmstudio/mcp.json` |
| Continue | `mcpServers`（YAML 列表） | `~/.continue/config.yaml` |
| Codex CLI | `mcp_servers`（TOML） | `~/.codex/config.toml` |

**通用 JSON 片段**（适用于 `mcpServers` 根键的客户端）：

```json
{
  "mcpServers": {
    "fanqie-writer": {
      "command": "node",
      "args": ["<你的路径>/fanqie-writer-mcp/server.js"]
    }
  }
}
```

**VS Code**（根键是 `servers`，远程条目必须显式写 `type`）：

```json
{
  "servers": {
    "fanqie-writer": {
      "type": "stdio",
      "command": "node",
      "args": ["<你的路径>/fanqie-writer-mcp/server.js"]
    }
  }
}
```

**Zed**（根键是 `context_servers`）：

```json
{
  "context_servers": {
    "fanqie-writer": {
      "command": "node",
      "args": ["<你的路径>/fanqie-writer-mcp/server.js"],
      "env": {}
    }
  }
}
```

**OpenCode**（根键是 `mcp`，命令写成数组）：

```json
{
  "mcp": {
    "fanqie-writer": {
      "type": "local",
      "command": ["node", "<你的路径>/fanqie-writer-mcp/server.js"],
      "enabled": true
    }
  }
}
```

**Continue**（YAML，`mcpServers` 是列表）：

```yaml
mcpServers:
  - name: fanqie-writer
    command: node
    args:
      - <你的路径>/fanqie-writer-mcp/server.js
```

**Codex CLI**（TOML）：

```toml
[mcp_servers.fanqie-writer]
command = "node"
args = ["<你的路径>/fanqie-writer-mcp/server.js"]
```

### 6.3 平台型 Agent：HTTP 模式

Dify、n8n、扣子、ChatGPT Connectors 这类平台不拉起本地进程，只接受一个 HTTP 端点。先把服务跑起来：

```bash
node server.js --http 8787
```

端点地址：`http://127.0.0.1:8787/mcp`（健康检查：`/health`）

在平台侧填：

```json
{
  "mcpServers": {
    "fanqie-writer": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

平台通常跑在容器或远端机器上，此时用 `--host 0.0.0.0` 监听，并**务必设置访问令牌**：

```bash
FANQIE_HTTP_TOKEN=你的随机长串 node server.js --http 8787 --host 0.0.0.0
```

客户端带上令牌：

```json
{
  "mcpServers": {
    "fanqie-writer": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer 你的随机长串" }
    }
  }
}
```

> 未设置 `FANQIE_HTTP_TOKEN` 时端点不校验鉴权，仅建议用于本机回环地址。

### 6.4 命令行速查

```bash
node server.js                # stdio（默认）
node server.js --http 8787    # 同时开启 Streamable HTTP
node server.js --http 0       # 仅 HTTP，端口随机
node server.js --help         # 全部参数
```

### 6.5 接入后自检

1. 客户端里能看到 9 个工具：`check_auth`、`list_books`、`use_book`、`list_volumes`、`list_chapters`、`upload_chapter`、`batch_upload`、`update_chapter`、`preview_html`。
2. 调 `check_auth` 返回 `auth: "ok"` 与账号下的作品列表。
3. 工具不出现时，按顺序排查：根键名是否正确（见 6.2 表）→ 客户端是否需重启 → 客户端日志里的启动命令是否报错 → `node server.js` 手动跑一遍看 stderr。
