# Todo Bridge — 项目说明文档

> **一句话**: 通过 Chrome DevTools Protocol (CDP) 直连 Todo清单 桌面端（Electron 应用）的 Vuex Store，实现对任务的增删改查。不需要 REST API、不需要逆向协议、不需要模拟登录。

> 📖 **快速上手**：给人看的 CLI 教程见 [`docs/USAGE.md`](docs/USAGE.md)；给 AI Agent 的 MCP 调用指南见 [`docs/AI_USAGE.md`](docs/AI_USAGE.md)。

---

## ⚡ 快速上手（小白版，约 5 分钟）

> 目标：装好 todo-bridge，跑通 `node src/cli.js ping`（看到 `connected: true`），再接入 AI。
> 全程只需要 ① 装两个软件 ② 下载项目 ③ 配置一个路径 ④ 跑两条命令。

### 第 1 步：安装 Node.js（一次性）

1. 打开 <https://nodejs.org>，下载左侧 **LTS**（长期支持）版本，双击安装，一路「下一步」。
2. 装完打开「命令提示符」或「PowerShell」，输入：
   ```bat
   node --version
   ```
   能看到 `v18` 或更高的版本号就 OK。提示"不是内部或外部命令"，多半是没装好或没重启终端——重开一个窗口再试。

### 第 2 步：安装 Todo清单 官方 Windows 电脑版（一次性）

从官方渠道安装 **Todo清单** Windows 电脑版并登录你的账号。
todo-bridge 是"遥控"这个桌面端、不是独立客户端，所以这步必须有。

### 第 3 步：下载本项目

1. 打开本仓库首页 → 点右上角绿色 **Code** 按钮 → **Download ZIP**。
2. 解压到任意目录，本文示例用 `C:\todo-bridge`（解压后能看到 `README.md`、`src\`、`start-todo-debug.bat` 等文件）。

### 第 4 步：安装依赖

打开「命令提示符」，进入项目目录并安装：
```bat
cd C:\todo-bridge
npm install
```
等它跑完、没有红色报错即可。

### 第 5 步：告诉工具你的 Todo清单.exe 在哪（关键！）

1. 找到 `Todo清单.exe`：右键桌面或开始菜单里的「Todo清单」→「打开文件所在位置」，把地址栏里的完整路径记下来。
2. 用**你的实际路径**执行（`C:\...` 只是示例，一定要替换）：
   ```bat
   setx TODO_LIST_EXE "C:\Program Files\Todo清单\Todo清单.exe"
   ```
3. **关掉并重开所有命令行窗口**（`setx` 只对新窗口生效），再继续下一步。

> 找不到 exe？可用 `where /r C:\ Todo清单.exe` 全盘搜一下（可能较慢）。

### 第 6 步：以调试模式启动 Todo清单

双击项目里的 **`start-todo-debug.bat`**。
它会自动：关闭旧的 Todo清单 → 用调试端口 9222 重新启动 → 等到端口就绪。
启动后 Todo清单 窗口会正常打开，**别关它**（工具要靠它读写数据）。

> 打不开 / 报"未设置 TODO_LIST_EXE"？回第 5 步检查：环境变量是否设置、路径是否写对、命令行窗口是否重启过。

### 第 7 步：验证是否成功

回到第 4 步那个命令行窗口，运行：
```bat
cd C:\todo-bridge
node src/cli.js doctor
node src/cli.js ping
```
看到 `connected: true` 和你的任务统计 = **安装成功**！

接下来你可以：
- **人用**：按 [`docs/USAGE.md`](docs/USAGE.md) 用命令行管理任务（查今天的、加任务、标完成……）；
- **给 AI 用**：按下面「五、AI 客户端接入」接进 Claude Desktop / Cursor / gateway。

### 卡住了？

看「八、常见问题排查」；还是不行就提 Issue，把 `node src/cli.js doctor` 的输出一起贴上来，能更快帮你定位。

> 💡 两个高频坑：
> ① Todo清单 要从 bat / 快捷方式启动，直接在终端里 `.\Todo清单.exe` 会秒退；
> ② `ping` 报 `CDP.List timeout` = 9222 端口没起来，重跑第 6 步。

---

## 一、技能概述

| 属性 | 值 |
|------|-----|
| **名称** | `todo-bridge` |
| **版本** | 1.1.0 |
| **平台** | Windows 10+ / Node.js ≥ 18 |
| **原理** | CDP WebSocket → `Runtime.evaluate()` → 注入 JS 操作 Vuex Store |
| **传输协议** | MCP JSON-RPC 2.0 over STDIO / HTTP(Streamable) + REST |
| **前置依赖** | `chrome-remote-interface` (npm)、Todo清单.exe 以 `--remote-debugging-port=9222` 启动 |

### 能做什么

| 操作 | 对应能力 |
|------|----------|
| 🏥 诊断 | 检查环境（exe 路径、端口、Node 版本）、Store 结构 |
| 📊 概览 | 获取任务总数、活跃数、分类列表 |
| 📋 查询 | 全部 / 按分类 / 活跃状态 / **按计划日期** / **无日期** / **时间范围** / **提醒日期** 筛选任务 |
| 🔍 单查 | 按 `id` 或 `taskId` 查单条任务 |
| ➕ 创建 | 创建任务（标题、备注、日期、提醒、分类、难度、子任务），**返回 taskId** |
| ✏️ 修改 | 改标题/备注/日期/提醒/分类/难度，**标记完成/未完成** |
| 🗑️ 删除 | 按 `id` 或 `taskId` 删除任务 |
| 🔄 同步 | 触发云端同步 |

### 不能做什么

| 限制 | 原因 |
|------|------|
| ❌ 工作量/难度显示 | `addTodo` 变异硬编码 `snowAdd:0`，UI 读取 `snowAdd` 显示工作量。**`updateTodo` 可在创建后补设 `snowAdd`** |
| ❌ 运行平台 | 仅 Windows（依赖 Todo清单.exe Electron 进程）。限的是**本工具的运行环境**，不是你的数据——Todo清单 自带云同步，改动可跨端生效（见下方"使用前提"） |

### 使用前提

| 前提 | 说明 |
|------|------|
| ✅ **需要 Todo清单 官方 Windows 电脑版** | 本项目通过 CDP 直连官方桌面端（Electron）的 Vuex Store 读写，**不是独立客户端**，也**不是官方 API**。请自行从官方渠道安装 Todo清单 电脑版并登录。本工具改的任务会经官方云同步到你已登录的其他设备。 |
| 💰 **部分能力可能需会员** | 提醒、多端同步、云端备份等功能依赖你的 Todo清单 账号会员状态。本工具只操作你已登录账号的本机数据；未开通会员时查询/增删改通常可用，云端同步可能受限。 |
| 🖥️ **运行仅限 Windows，数据跨端** | 工具依赖 Todo清单 Windows 桌面进程，只能在 Windows 上运行；但操作结果经官方**多端云同步**，在你已登录的手机 / 平板 / 其他电脑上同步生效。 |
| 🔧 **一次环境配置** | 设置 `TODO_LIST_EXE` 指向你的 `Todo清单.exe`（见下文"环境变量配置"），执行 `npm install` 即可。 |

### 环境变量配置

```bash
# Windows (cmd) 用户级设置一次即可
setx TODO_LIST_EXE "D:\path\to\Todo清单.exe"

# 或临时（当前终端）
set TODO_LIST_EXE=D:\path\to\Todo清单.exe
```

`src/config.js` 读取 `TODO_LIST_EXE`；未设置时使用占位符。`start-todo-debug.bat` 同样依赖该变量。

### 如何获取分类 ID

分类 ID 是你账号的**动态数据**，不需要（也不该）写死。用下面任一方式实时获取：

| 方式 | 命令 |
|------|------|
| MCP 工具 | `todo.getCategories`（`todo.ping` 返回里也带 `categories`） |
| CLI | `node src/cli.js categories` |

每个分类返回 `{ categoryId, categoryName, categoryColor }`。`0` 是默认"收集箱"。**本文档示例里的 `categoryId: 12345` 只是占位符**，请替换为你账号里实际返回的 ID。

### 按日期 / 无日期查询

`todo.getTodos` / `cli list` 支持对计划日期（`todoTime` 字段）筛选：

| 场景 | 参数 |
|------|------|
| 某一天的任务 | `date: "YYYY-MM-DD"` |
| 某个时间范围（精确到时刻） | `from` / `to`，如 `"2026-08-27 09:00"` |
| 无计划日期的任务 | `noDate: true` |
| 某天有提醒的任务 | `reminderDate: "YYYY-MM-DD"` |
| 提醒时间范围 | `reminderFrom` / `reminderTo` |

---

## 二、架构速览

```
AI (MCP Client)
  │  MCP over STDIO  /  MCP over HTTP (/mcp, Streamable)  /  REST (/call/:toolName)
  ▼
mcp-server.js          ← 共享工具注册表，三入口路由
  │
  ▼
todo-client.js         ← CDP 引擎：连接、注入 JS、解析结果
  │  Chrome DevTools Protocol (WebSocket)
  ▼
Todo清单.exe (Electron)
  └─ Vue 2 + Vuex Store (todoList 数组, todoTime=计划日期ms, reminderTime=提醒ms)
```

### 关键字段映射（Todo项）

| 业务含义 | Store 字段 | 说明 |
|----------|-----------|------|
| 任务标题 | `taskContent` | 必填 |
| 任务备注 | `taskDescribe` | 可选 |
| 完成状态 | `complete` | `true`=已完成 |
| 删除标记 | `delete` | `true`=已删除（软删除） |
| 计划日期 | `todoTime` | 毫秒级 Unix 时间戳，`0`=无日期 |
| 提醒时间 | `reminderTime` | 毫秒级 Unix 时间戳 |
| 所属分类 | `standbyInt1` | 存储 `categoryId` 值 |
| 子任务 | `standbyStr2` | 格式: 每条 `- [ ]内容`（`[x]`=已完成），条目间用 `[end] - ` 分隔。如 `- [ ]子任务1[end] - [x]子任务2[end] - [ ]子任务3` |
| 子任务(解析) | `subtasks` | 查询时由 `standbyStr2` 自动解析：`[{content, done}]`，AI 可直接使用；原始串保留在 `standbyStr2` |
| 同步状态 | `status` | `"sync"`/`"update"`/`"add"` |
| 服务端 ID | `id` | ⚠️ **v3.14.0 实测无此字段**（任务均无数字 id）；当前版本任务仅靠 `taskId` 唯一标识 |
| 本地 UUID | `taskId` | 创建时立即生成，**唯一可靠引用**，格式 `tid_<userId>_<uuid>_<ts>` |
| **工作量** | `snowAdd` | ⚠️ UI 读取此字段显示工作量，`addTodo` 硬编码为 0，可用 `updateTodo` 补设 |
| 难度级别 | `snowAssess` | 存 `todoDifficultyLevel` 参数值，但 UI 不读此字段 |

---

## 三、CLI 命令参考

> 所有命令需在项目根目录 `<todo-bridge 目录>\` 下执行。
> App 必须已以 `--remote-debugging-port=9222` 启动。

| # | 命令 | 说明 | 需要 CDP |
|---|------|------|----------|
| 1 | `node src/cli.js doctor` | 环境诊断（exe路径、端口、进程、Node版本） | ❌ |
| 2 | `node src/cli.js diagnose` | Store 结构诊断（模块/字段/action/mutation） | ✅ |
| 3 | `node src/cli.js ping` | 连接测试 + Store 总览 | ✅ |
| 4 | `node src/cli.js categories` | 列出所有分类 | ✅ |
| 5 | `node src/cli.js list [筛选]` | 列出任务（日期/无日期/时间范围/提醒筛选；默认排除已删除） | ✅ |
| 5b | `node src/cli.js today [--active]` | **今天所有任务**（本地时区，免拉全量） | ✅ |
| 6 | `node src/cli.js get <id\|taskId>` | 查询单条任务 | ✅ |
| 7 | `node src/cli.js add "标题"` | 创建任务 | ✅ |
| 8 | `node src/cli.js update <id>` | 修改任务 / 标记完成 | ✅ |
| 9 | `node src/cli.js delete <id\|taskId>` | 删除任务 | ✅ |
| 10 | `node src/cli.js sync` | 触发云端同步 | ✅ |
| 11 | `node src/cli.js mcp [--http] [--port N]` | 启动 MCP Server（默认 STDIO） | — |

### 常用命令示例

```bash
# 查询今天 / 某天 / 无日期的任务
node src/cli.js list --date 2026-08-27
node src/cli.js list --no-date --active --limit 20
node src/cli.js list --from "2026-08-27 09:00" --to "2026-08-27 18:00"
# 提醒时间范围 / 含已删除任务
node src/cli.js list --reminder-date 2026-08-27
node src/cli.js list --reminder-from "2026-08-27 14:00" --reminder-to "2026-08-27 15:00"
node src/cli.js list --date 2026-08-27 --include-deleted

# 创建（返回 taskId）
node src/cli.js add "买菜" --difficulty 2 --date 2026-08-27 --reminder 09:00 --categoryId 12345 --content "有机的"
# 带子清单（[x]=已完成；分隔符 [end] - ；bash 里整段加引号防 glob；categoryId 用 categories 查你账号的）
node src/cli.js add "周末清单" --categoryId 12345 --sublist "- [ ]买菜[end] - [x]拖地[end] - [ ]看书"

# 修改 / 标记完成（按 id 或 taskId 均可）
node src/cli.js update tid_xxx --complete true
node src/cli.js update tid_xxx --content "新备注" --date 2026-08-28

# 删除（不可逆！）
node src/cli.js delete tid_xxx
```

---

## 四、MCP 工具 Schema

### 工具一览

| 工具名 | 说明 | 主要参数 |
|--------|------|----------|
| `todo.ping` | 连接诊断 + Store 概览 | 无 |
| `todo.getDiagnostics` | Store 结构诊断 | 无 |
| `todo.getCategories` | 列出所有分类 | 无 |
| `todo.getTodos` | 列出任务（分类/活跃/日期/无日期/时间范围/提醒筛选；**默认排除已删除**） | `active?`, `includeDeleted?`, `categoryId?`, `date?`, `noDate?`, `from?`, `to?`, `reminderDate?`, `reminderFrom?`, `reminderTo?`, `limit?` |
| `todo.todayTodos` | **今天（本地时区）所有任务**，自动按当天过滤，免拉全量 | `active?`, `includeDeleted?`, `categoryId?`, `limit?` |
| `todo.getTodo` | 查单条任务 | `todoId*` |
| `todo.createTodo` | 创建任务（返回 `taskId`） | `title*`, `content?`, `categoryId?`, `difficulty?`, `date?`, `reminderTime?`, `sublist?` |
| `todo.updateTodo` | 修改 / 标记完成 | `todoId*`, `complete?`, `title?`, `content?`, `date?`, `reminderTime?`, `categoryId?`, `difficulty?` |
| `todo.deleteTodo` | 删除任务 | `todoId*` |
| `todo.syncNow` | 触发云端同步 | 无 |

> `todoId` 为 `["number","string"]`：接受数字 `id` 或 `taskId` 字符串。⚠️ **当前 v3.14.0 无数字 `id`，请用 taskId**（传数字会返回 not found）。

### `todo.getTodos`

```json
{
  "name": "todo.getTodos",
  "inputSchema": {
    "type": "object",
    "properties": {
      "active":        { "type": "boolean", "description": "仅返回活跃（未完成未删除）任务" },
      "includeDeleted":{ "type": "boolean", "description": "true=同时返回已删除(软删)任务；默认排除" },
      "categoryId":    { "type": "number",  "description": "按分类 ID 筛选" },
      "limit":         { "type": "number",  "description": "返回条数上限" },
      "date":          { "type": "string",  "description": "计划日期 YYYY-MM-DD，返回当天任务" },
      "noDate":        { "type": "boolean", "description": "true=仅返回无计划日期的任务" },
      "from":          { "type": "string",  "description": "计划时间范围起点" },
      "to":            { "type": "string",  "description": "计划时间范围终点（闭区间）" },
      "reminderDate":  { "type": "string",  "description": "提醒日期 YYYY-MM-DD" },
      "reminderFrom":  { "type": "string",  "description": "提醒时间范围起点" },
      "reminderTo":    { "type": "string",  "description": "提醒时间范围终点" }
    }
  }
}
```

> ✅ **返回的每个任务额外带 `subtasks` 数组**（由 `standbyStr2` 解析），同时保留原始 `standbyStr2` 字符串。无子清单时 `subtasks: []`。
> 示例：`{ "content": "买菜", "done": false }` / `{ "content": "拖地", "done": true }`（`done: true` = 该子项已完成）。

### `todo.todayTodos` — 今天所有任务（推荐，避免全量拉取爆 limit）

```json
{
  "name": "todo.todayTodos",
  "inputSchema": {
    "type": "object",
    "properties": {
      "active":         { "type": "boolean", "description": "true=仅返回未完成未删除的任务" },
      "includeDeleted": { "type": "boolean", "description": "true=同时返回已删除(软删)任务；默认排除" },
      "categoryId":     { "type": "number",  "description": "按分类 ID 筛选" },
      "limit":          { "type": "number",  "description": "返回条数上限" }
    }
  }
}
```

> 无日期参数——自动用**本地时区今天**过滤 `dayStart||todoTime`。默认含今天已完成，`active:true` 只看未完成。返回结构与 `getTodos` 一致（含 `subtasks`）。

### `todo.createTodo`

```json
{
  "name": "todo.createTodo",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title":        { "type": "string", "description": "任务标题（必填）" },
      "content":      { "type": "string", "description": "任务备注/详情" },
      "categoryId":   { "type": "number", "description": "所属分类 ID（收集箱=0）" },
      "difficulty":   { "type": "number", "description": "难度/工作量（1-低, 2-中, 3-高）" },
      "date":         { "type": "string", "description": "计划日期，如 2026-08-27" },
      "reminderTime": { "type": "string", "description": "提醒时间，如 09:00（与 date 合成；无 date 默认今天）" },
      "sublist":      { "type": "string", "description": "子任务/清单，每条 \"- [ ]内容\" 或 \"- [x]已完成\"，条目间用 \"[end] - \" 分隔。示例：\"- [ ]买牛奶[end] - [x]拖地\"" }
    },
    "required": ["title"]
  }
}
```

> ✅ **v1.1.0 起 `createTodo` 返回 `taskId`**，AI 可引用它做后续 `updateTodo`/`deleteTodo`。
> ✅ **分类 + 子任务同建于创建时**：`categoryId` 选择分类；`sublist` 写子清单（存储为 `standbyStr2`，UI 原生显示并可勾选）。

### `todo.updateTodo`

```json
{
  "name": "todo.updateTodo",
  "inputSchema": {
    "type": "object",
    "properties": {
      "todoId":       { "type": ["number","string"], "description": "任务 ID（数字 id 或 taskId）" },
      "complete":     { "type": "boolean", "description": "标记完成/未完成" },
      "title":        { "type": "string", "description": "新标题" },
      "content":      { "type": "string", "description": "新备注/详情" },
      "date":         { "type": "string", "description": "计划日期 YYYY-MM-DD" },
      "reminderTime": { "type": "string", "description": "提醒时间 HH:MM" },
      "categoryId":   { "type": "number", "description": "新分类 ID" },
      "difficulty":   { "type": "number", "description": "难度（1-3）" }
    },
    "required": ["todoId"]
  }
}
```

### MCP 交互示例

**Request:**
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "todo.createTodo", "arguments": { "title": "买菜", "categoryId": 12345, "date": "2026-08-27", "reminderTime": "09:00" } } }
```

**Response:**
```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"ok\":true,\"taskId\":\"tid_xxx\",\"params\":{...}}" }] } }
```

---

## 五、AI 客户端接入

### 方式 A — STDIO（Claude Desktop / Cursor / 任意 MCP 客户端）

```json
{
  "mcpServers": {
    "todo-bridge": {
      "command": "node",
      "args": ["<todo-bridge 绝对路径>/src/cli.js", "mcp"]
    }
  }
}
```

### 方式 B — MCP Streamable HTTP（gateway / 远程 / 网络型客户端）

```bash
node src/mcp-server.js --http --port 3100
```

gateway `config.yaml` 的 `mcp_servers` 追加（**需先启动上述 HTTP 服务**）：

```yaml
mcp_servers:
  - name: todo-bridge
    url: http://127.0.0.1:3100/mcp
    transport: streamable        # 或 http
    disabled_tools: []
    groups: {}
```

> ⚠️ 若 HTTP 服务未启动，gateway 拉工具列表会等到 30s 超时再跳过——不用时把该条目注释掉。

### 方式 C — REST API（脚本 / 直接调用）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查，返回工具列表 |
| `/tools` | GET | 返回所有工具的 name/description/inputSchema |
| `/call/:toolName` | POST | 调用指定工具，body 为 JSON 参数 |
| `/mcp` | POST | MCP Streamable HTTP（JSON-RPC） |

```bash
curl -X POST http://127.0.0.1:3100/call/todo.getTodos -H "Content-Type: application/json" -d '{"date":"2026-08-27","active":true,"limit":10}'
```

---

## 六、已知限制与注意事项

### 🟡 工作量/难度在 UI 中不显示（上游限制）

- Todo清单 `addTodo` 变异硬编码 `snowAdd:0`，UI 读取 `snowAdd` 渲染工作量。
- **Workaround**: 创建后用 `todo.updateTodo` 补设：
  - `todo.updateTodo` 参数 `difficulty` → 写入 `snowAssess`（不显示）；
  - 直接传原始 store 字段可补 `snowAdd`（需确认 mutation 透传行为）。
- **根本修复**: 需反编译/补丁 Todo清单.exe。

### 🟡 当前版本（v3.14.0）没有数字 `id`

- **实测**：任务 `id` 字段全部为空/不存在。任务唯一标识就是 `taskId`（`tid_<userId>_<uuid>_<ts>`）。
- `todoId` 传数字会优雅返回 `todo not found`，不会崩；**请一律用 taskId**。
- `createTodo` 已返回 `taskId`；`updateTodo`/`deleteTodo`/`getTodo` 均支持 taskId。

### 🟡 多页面 target 选择

- 番茄钟浮动窗等可能干扰 `_pickTarget()`，已优先匹配 `#/todo-list/today` 主页面。
- ⚠️ 实测偶发：多次快速调用（每次独立 CDP 连接）可能命中不同 target，导致结果看似"不一致"。连不上/结果异常时重试一次即可。

### 🟡 连接失败

- connect 带超时（`CONFIG.timeout`，默认 15s），store 未就绪会轮询 5 次×500ms。MCP 每次 `tools/call` 独立 Session，下次调用自动重连。

### 🟢 `cdp-client.js` 死代码

- `src/cdp-client.js` 未被引用，保留供未来重构参考。

---

## 七、环境搭建

### 前置条件

1. **Node.js ≥ 18** — 验证: `node --version`
2. **npm 依赖** — `cd <todo-bridge 目录> && npm install`
3. **配置 exe 路径** — 设置环境变量 `TODO_LIST_EXE` 指向你的 `Todo清单.exe`（见上方「⚡ 快速上手」第 5 步）。`setx TODO_LIST_EXE "..."` 永久生效；临时生效用 `set TODO_LIST_EXE=...`

### 启动流程

```
① 启动 Todo清单（CDP 模式）
   双击 start-todo-debug.bat
   或: 创建快捷方式 → 目标加 --remote-debugging-port=9222 --remote-allow-origins=* → 双击

② 验证连接
   node src/cli.js doctor
   node src/cli.js ping

③ 启动 MCP Server
   node src/cli.js mcp                        # STDIO 模式
   node src/cli.js mcp --http --port 3100     # HTTP 模式（MCP /mcp + REST）
```

> ⚠️ **App 必须"分离启动"**：Todo清单.exe 从 git-bash / PowerShell 直接启动会**干净退出**（exit 0），只有经 `start`/快捷方式/`explorer.exe`（无控制台挂载）启动才会常驻。`start-todo-debug.bat` 用的正是 `start`，OK。
> ⚠️ **别从 git-bash 直接传参给 exe**：MSYS 会把 `--xxx` mangle 成路径，App 报 `bad option` 并退出。参数必须走快捷方式 / bat / cmd `start`。

---

## 八、常见问题排查

| 症状 | 可能原因 | 解决 |
|------|----------|------|
| `No CDP targets` | Todo清单未以 CDP 端口启动 | 检查 `--remote-debugging-port=9222` 参数 |
| `no store` | 页面未完全加载 | 等待几秒重试；检查 `start-todo-debug.bat` 是否等待端口就绪 |
| `Eval error` | 注入的 JS 表达式有语法错误 | `node src/cli.js diagnose` 检查 Store 结构是否变化 |
| `Cannot find module 'chrome-remote-interface'` | 依赖未安装 | `npm install` |
| `端口未开放` | `start-todo-debug.bat` 未执行或 fail | 检查 `tasklist` 是否有进程；手动执行 bat |
| App 一启动就退出（exit 0） | 从 git-bash / PowerShell 直接启动 GUI App | 用 bat 的 `start` / 快捷方式 / `explorer.exe` 分离启动 |
| `bad option: --remote-debugging-port` | 从 git-bash 直接传参，MSYS mangle 了 `--` 参数 | 参数走快捷方式 / bat，不要从 git-bash 直接拼命令行 |

---

## 九、项目文件清单

```
<todo-bridge 目录>\
├── README.md                ← 本文件
├── ARCHITECTURE.md          ← 详细架构文档
├── BUG_FIX_REPORT.md        ← Bug 修复报告
├── package.json
├── start-todo-debug.bat     ← ① 以 CDP 模式启动 Todo清单
├── start-mcp.bat            ← ② 启动 MCP Server (STDIO)
├── start-mcp-http.bat       ← ③ 启动 MCP Server (HTTP: /mcp + REST)
├── src/
│   ├── config.js            ← 配置（exe路径、CDP端口、超时、HTTP端口）
│   ├── todo-client.js       ← CDP 引擎核心
│   ├── mcp-server.js        ← MCP 协议服务器（STDIO + Streamable HTTP + REST）
│   ├── cli.js               ← CLI 命令行入口
│   └── cdp-client.js        ← 备用 CDP 封装（未使用，保留）
└── test/
    ├── bridge.test.js       ← 注入逻辑单测（vm 伪造 store）
    └── mcp.test.js          ← MCP 协议层单测（mock 客户端）
```

---

## 十、AI Agent 使用提示

1. **获取上下文**: 先 `todo.ping` + `todo.getCategories` 了解任务数与分类。
2. **查询任务**: 用 `active=true` + `limit`；按日期用 `date`/`noDate`/`from`/`to`，避免全量拉取。
3. **创建任务**:
   - 确认目标日期（今天/明天/具体日期）与分类（不确定就列出来让用户选）。
   - 成功后用返回的 `taskId` 记住新任务。
4. **修改/完成**: `todo.updateTodo` 传 `complete:true` 即可标完成。
5. **删除任务**: 先 `todo.getTodo` 确认，避免误删。
6. **操作后同步**: 创建/删除后建议 `todo.syncNow`。
7. **出错时**: `todo.getDiagnostics` 确认 Store 结构未变化。
