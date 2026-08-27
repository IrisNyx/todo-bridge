# Todo Bridge — 项目架构文档

> 版本: 1.1.0 · 最后更新: 2026-08-27

---

## 一句话

通过 **Chrome DevTools Protocol (CDP)** 连接到 Todo清单 桌面端（Electron 应用）的运行时进程，注入 JavaScript 直接操作其 Vuex Store，从而实现 AI（通过 MCP 协议）对任务的增删改查。

不需要 Todo清单 开放 REST API、不需要逆向加密协议、不需要模拟登录。

---

## 架构分层

```
┌─────────────────────────────────────────────────────────┐
│                      AI / Agent                           │
│  (Dinox / Claude / Cursor / 任意 MCP 客户端)              │
└──────────────────────┬──────────────────────────────────┘
                       │ MCP 协议 (JSON-RPC 2.0 over STDIO)
                       ▼
┌─────────────────────────────────────────────────────────┐
│                  mcp-server.js                            │
│  MCP Server — 共享工具注册表 + 三入口路由                 │
│  STDIO (默认) / HTTP: POST /mcp (Streamable) + REST      │
│                                                          │
│  工具列表:                                               │
│    todo.ping            连接诊断 + Store 概览             │
│    todo.getCategories   列出所有分类                       │
│    todo.getTodos        列出任务 (分类/活跃/日期/无日期/   │
│                         时间范围/提醒筛选, 默认排除已删除)  │
│    todo.getTodo         按 id/taskId 查单条               │
│    todo.createTodo      创建任务 (返回 taskId)            │
│    todo.updateTodo      修改任务 / 标记完成               │
│    todo.deleteTodo      按 id/taskId 删除任务             │
│    todo.syncNow         触发云端同步                       │
│    todo.getDiagnostics  Store 结构诊断 (适配用)           │
└──────────────────────┬──────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────┐
│                  todo-client.js                           │
│  CDP 引擎核心 — 管理 WebSocket 连接、注入 JS、解析结果    │
│                                                          │
│  connect()         → 连 CDP → 找主页面 → 建 Session      │
│  close()           → 关闭连接                             │
│  _eval(expr)       → 在目标页面 Runtime 执行 JS 表达式    │
│  ping()            → 获取总览状态                         │
│  getCategories()   → 读取 state.category.list            │
│  getTodos(filter)  → 读取 state.todo.todoList (可筛选,    │
│                       date按dayStart||todoTime, 默认排除已删)│
│  createTodo(params)→ 调 todo/addTodo action              │
│  deleteTodo(id)    → 调 todo/deleteTodo action           │
│  syncNow()         → dispatch todo/refreshTodos          │
│  getDiagnostics()  → 探测 Store 结构                     │
└──────────────────────┬──────────────────────────────────┘
                       │ Chrome DevTools Protocol (WebSocket)
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Todo清单桌面端 (Electron App)                │
│                                                          │
│  ┌─────────────────────────────────────┐                │
│  │  Chromium 渲染进程 (Renderer)       │                │
│  │  ┌──────────────────────────────┐   │                │
│  │  │  Vue 2 + Vuex Store          │   │                │
│  │  │                              │   │                │
│  │  │  state:                      │   │                │
│  │  │    ├─ todo.todoList[]        │   │                │
│  │  │    │   ├─ taskId             │ ← 唯一标识(⚠️无id) │
│  │  │    │   ├─ userId             │ ← 用户ID           │
│  │  │    │   ├─ taskContent        │ ← 标题             │
│  │  │    │   ├─ taskDescribe       │ ← 备注             │
│  │  │    │   ├─ complete/delete    │ ← 完成/软删除      │
│  │  │    │   ├─ todoTime           │ ← 计划时间(ms)     │
│  │  │    │   ├─ dayStart           │ ← 按天归组键(ms)   │
│  │  │    │   ├─ reminderTime       │ ← 提醒时间(ms)     │
│  │  │    │   ├─ standbyInt1        │ ← 分类ID           │
│  │  │    │   ├─ snowAdd/snowAssess │ ← 工作量/难度      │
│  │  │    │   └─ status/version ... │                   │
│  │  │    ├─ category.list[]        │                   │
│  │  │    │   ├─ categoryId         │                   │
│  │  │    │   ├─ categoryName       │                   │
│  │  │    │   ├─ categoryColor      │                   │
│  │  │    │   └─ ...                │                   │
│  │  │    ├─ auth.user              │                   │
│  │  │    │   ├─ userId             │ (非 id)            │
│  │  │    │   └─ ...                │                   │
│  │  │    └─ ... 共 15 个模块       │                   │
│  │  │                              │                   │
│  │  │  actions:                    │                   │
│  │  │    todo/addTodo              │ ← 新增任务         │
│  │  │    todo/deleteTodo           │ ← 删除任务         │
│  │  │    todo/refreshTodos         │ ← 同步/刷新        │
│  │  └──────────────────────────────┘                   │
│  └─────────────────────────────────────┘                │
│                                                          │
│  ┌─────────────────────────────────────┐                │
│  │  后端同步引擎 (自动)                  │                │
│  │  Store 变更后自动同步到云端            │                │
│  └─────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────┘
```

---

## 核心技术原理

### 1️⃣ Chrome DevTools Protocol (CDP)

Electron 是 Chromium + Node.js。启动时加上调试参数，就在 `localhost:9222` 开启一个 **调试 WebSocket 服务器**：

```bash
Todo清单.exe --remote-debugging-port=9222 --remote-allow-origins=*
```

任何一个 CDP 客户端都可以：

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | `GET http://127.0.0.1:9222/json/list` | 列出所有页面的调试 URL |
| 2 | 连接目标页面的 `webSocketDebuggerUrl` | 建立 CDP Session |
| 3 | 调用 `Runtime.evaluate({ expression, returnByValue })` | 在页面上下文执行任意 JS |
| 4 | 读取 `result.value` | 获取返回值 |

### 2️⃣ Vuex Store 注入

核心脚本——找到 Vue 根实例，取出 Store：

```js
var el = document.querySelector('#app');
var vm = el.__vue__;          // Vue 2 实例
var store = vm.$store;        // Vuex Store
```

拿到 Store 后可以做的操作：

| 操作 | 代码 |
|------|------|
| **读取任务列表** | `store.state.todo.todos` |
| **读取分类** | `store.state.category.list` |
| **创建任务** | `store._actions['todo/addTodo'][0](payload)` |
| **删除任务** | `store.dispatch('todo/deleteTodo', { id })` |
| **触发同步** | `store.dispatch('todo/refreshTodos')` |

> 为什么用 `_actions['todo/addTodo'][0]` 而不是 `store.dispatch`？
> 实测 `dispatch` 在某些版本会有 Promise 链问题，`_actions` 是 Vuex 内部注册的已包装 action 数组，调用第 0 个即可。

### 3️⃣ MCP 协议

`mcp-server.js` 实现了 **Model Context Protocol** 的 JSON-RPC 2.0 子集：

| 方法 | 方向 | 说明 |
|------|------|------|
| `initialize` | Client → Server | 握手协商协议版本与能力 |
| `notifications/initialized` | Client → Server | 通知客户端已初始化完成 |
| `ping` | Client → Server | 存活检测，返回 `{}` |
| `tools/list` | Client → Server | 获取可用工具列表及参数 Schema |
| `tools/call` | Client → Server | 调用指定工具并传参（工具级错误标 `isError:true`） |

三种入口（共享同一 `TOOLS` 注册表）：

- **STDIO 模式**（默认）：通过标准输入/输出管道读写 JSON 行。适合集成到 Claude Desktop、Cursor 等 AI 客户端。
- **HTTP MCP 模式**（`--http`）：`POST http://127.0.0.1:3100/mcp` 为 **MCP Streamable HTTP**（JSON-RPC，sessionless 兼容，gateway 的 `transport: streamable/http` 可直接连）。
- **REST 模式**（同 `--http` 进程）：`GET /health`、`GET /tools`、`POST /call/:toolName`，适合脚本/测试直接调用。

---

## 文件结构

```
D:\software\todo-bridge\
│
├── package.json                  # 项目配置、依赖声明、npm scripts
├── start-todo-debug.bat          # ① 以 Debug 模式启动 Todo清单
├── start-mcp.bat                 # ② 启动 MCP Server（STDIO）
├── start-mcp-http.bat            # ③ 启动 MCP Server（HTTP）
│
├── ARCHITECTURE.md               # ← 本文档
│
└── src/
    ├── config.js                 # 配置：exe路径、CDP端口、超时
    ├── todo-client.js            # CDP 引擎核心（144行）
    ├── mcp-server.js             # MCP 协议服务器（264行）
    └── cli.js                    # CLI 命令行入口（153行）
```

---

## 启动流程

### 完整链路

```
步骤       谁做              做什么
───       ───              ───
  1       USER             双击 start-todo-debug.bat
                              │
  1.1     bat              taskkill /f /im "Todo清单.exe"
  1.2     bat              start "Todo清单.exe" --remote-debugging-port=9222
  1.3     bat              轮询 netstat 直到 9222 监听
  1.4     bat              提示 "就绪"
                              │
  2       USER / AI        启动 MCP Server
                              │
  2.1     mcp-server.js    require('./todo-client')
  2.2     mcp-server.js    等待 STDIO JSON (MCP 协议)
                              │
  3       AI (MCP 客户端)   调用某个工具
                              │
  3.1     mcp-server.js    解析 tools/call 请求
  3.2     todo-client.js    new TodoClient().connect()
  3.3     todo-client.js    CDP.List() → 列出所有页面
  3.4     todo-client.js    _pickTarget() → 选主页面
  3.5     todo-client.js    CDP({ target }) → 建 Session
  3.6     todo-client.js    Runtime.enable()
  3.7     todo-client.js    Runtime.evaluate(expr) → 注入 JS
  3.8     todo-client.js    解析结果值
  3.9     todo-client.js    close()
  3.10    mcp-server.js    返回 MCP Content 给客户端
```

### start-todo-debug.bat 细节

```batch
@echo off
chcp 65001 >nul                          :: UTF-8 编码
taskkill /f /im "Todo清单.exe" 2>nul     :: 强杀旧进程
timeout /t 2 /nobreak >nul               :: 等端口释放

:: 以 CDP 模式启动
start "TodoDebug" "D:\software\todolist\todo-list\Todo清单.exe" ^
    --remote-debugging-port=9222 ^
    --remote-allow-origins=*

:: 轮询直到 9222 端口上线
:waitloop
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":9222.*LISTENING" >nul
if %errorlevel% neq 0 goto waitloop

echo CDP 端口 9222 已就绪
pause
```

---

## 数据流详解

### createTodo 示例

```
AI 发送: {"method":"tools/call","params":{"name":"todo.createTodo","arguments":{"title":"买菜"}}}
        │
        ▼
mcp-server.js handler
  → 构建 payload: { todoContent: "买菜", categoryId: 0, addToTop: true, ... }
  → client.connect()
    → CDP.List() → 获取页面列表
    → CDP({ target: 主页面 }) → WebSocket 连接
    → Runtime.enable()
  → client.createTodo(payload)
    → Runtime.evaluate(expression: 注入脚本)
        │
        ▼
    在 Electron 渲染进程执行:
      var el = document.querySelector('#app');
      var store = el.__vue__.$store;
      var p = { todoContent: "买菜", categoryId: 0, addToTop: true };
      var userId = store.state.auth.user.userId || store.state.auth.user.id;
      p.userId = userId;
      return store._actions['todo/addTodo'][0](p);
        │
        ▼
    Vuex action 执行:
      1. 生成 todo 对象 { taskId: "tid_<userId>_<uuid>_<ts>", taskContent: "买菜", ... }  // ⚠️ 无数字 id
      2. commit('addTodo', todo) → mutation 推入 state.todo.todoList
      3. 自动触发同步 → 请求后端 API
      4. 本地存储 (SQLite) 更新
        │
        ▼
  ← Runtime.evaluate 返回: { ok: true, taskId: "tid_<userId>_<uuid>_<ts>" }
  ← client.close()
  ← MCP 响应: { content: [{ type: 'text', text: '{"ok":true,...}' }] }
```

---

## 关键决策与约束

| 决策 | 理由 |
|------|------|
| **只读本地 Store，不走后端 API** | Todo清单 没有公开的 REST API 文档；CDP 注入是最小侵入、最稳定的方式 |
| **每次调用新建连接 + 关闭** | 避免 WebSocket 长连接状态漂移；MCP 每次 `tools/call` 都独立 Session |
| **Vue 2 `__vue__` 路径** | 该 App 基于 Vue 2.7，`__vue_app__`（Vue 3）不存在 |
| **调 `_actions[]` 而非 `dispatch`** | `dispatch` 在某些版本返回的 Promise 不兼容；`_actions` 是已注册的 action 包装器 |
| **`_pickTarget()` 优先主任务页面** | CDP 可能列出多个页面（番茄钟、设置页等），`#/todo-list/today` 是主页面 URL pattern |
| **`categoryId: 0` = 收集箱** | Todo清单 默认分类，创建任务不传分类时默认落入 |
| **使用 `JSON.parse/stringify` 返回数据** | Vuex state 包含大量响应式 getter/setter，直接返回会报循环引用；深拷贝后安全传输 |

---

## 已知问题

### ❌ mcp-server.js 与 todo-client.js 方法名不匹配（已修复）

- **症状**：调用 `todo.ping` 或 `todo.getDiagnostics` 时抛 `client.getStoreDiagnostics is not a function`
- **根因**：`mcp-server.js` 在工具 handler 里写了 `client.getStoreDiagnostics()`，但 `todo-client.js` 里的方法名为 `getDiagnostics()`
- **修复**：统一为 `getDiagnostics()`

### ⚠️ CDP 断开恢复

- 如果 App 崩溃、手动关闭或重启，CDP WebSocket 会断
- 当前行为：每次 `connect()` 都做新握手（带 `CONFIG.timeout` 超时），断开后下次调用自动重连

### ⚠️ 多页面 target 选择

- 如果 App 打开了多个窗口（如番茄钟浮动窗），`_pickTarget()` 可能选到错误的页面
- 当前行为：优先匹配 `#/todo-list/today`，不匹配则回退到第一个 page 类型 target
- 待优化：可在 `_pickTarget()` 失败后尝试 reload 主页面

### ✅ 页面未加载完成时注入

- store 未就绪时 `connect()` 会轮询最多 5 次 × 500ms；仍不行则业务方法返回 `{__error__:'no store'}`

### ⚠️ 启动方式必须分离（实测于 v3.14.0）

- 从 git-bash / PowerShell 直接 `./Todo清单.exe` 启动会**干净退出（exit 0）**，进程不驻留
- git-bash 直接传 `--remote-debugging-port=9222` 会被 **MSYS 参数改写**（`--xxx`/`*` 被 mangle），App 报 `bad option` 后退出
- **正确做法**：`start-todo-debug.bat`（内部用 `start`）或 Windows 快捷方式 / `explorer.exe "Todo清单.exe"` 分离启动

### ⚠️ v3.14.0 无数字 `id` 字段（实测任务全无）

- 任务唯一标识只有 `taskId`（`tid_<userId>_<uuid>_<ts>`）
- `state.auth.user` 用 `userId`（不是 `id`）；createTodo 注入用 `userId || id` 兜底，防止拼出 `tid_undefined_...`
- 老代码里一切按数字 `id` 匹配的路径都已改为 `taskId===String(id) || (有数字id时) Number(id)===id` 双匹配

### ⚠️ 默认排除已删除任务

- 软删除任务（`delete:true`）仍留在 `todoList` 里；`getTodos` 默认过滤掉
- 需要查已删除时传 `includeDeleted:true`

### ⚠️ `todoTime` / `dayStart` 语义（按天归组实测）

- 仅日期任务：`todoTime` = 计划日**本地零点**（`YYYY-MM-DDT00:00:00`）
- 设了时刻的任务：`todoTime` = 当天零点 + HH:mm
- `dayStart` = 按天归组键（计划日零点 ms）；老任务有、新建任务常缺
- `date` 筛选命中条件：`dayStart || todoTime` 落在当天 `[本地零点, 零点+24h)`

---

## 给接手 AI Agent 的快速指南

### 环境诊断

```bash
# 1️⃣ 确认 App 已以 Debug 模式运行
tasklist | findstr "Todo清单"

# 2️⃣ 确认 CDP 端口已开放
netstat -ano | findstr :9222

# 3️⃣ 查看可用 CDP 页面
curl http://127.0.0.1:9222/json/list

# 4️⃣ 完整环境诊断
node src/cli.js doctor
```

### 日常操作

```bash
node src/cli.js ping                          # 测试连接 + Store 总览
node src/cli.js categories                    # 列出所有分类
node src/cli.js list --date 2026-08-27        # 某天任务
node src/cli.js list --from "2026-08-27 09:00" --to "2026-08-27 12:00"  # 某天某个时间段
node src/cli.js list --no-date --active       # 无日期活跃任务
node src/cli.js list --reminder-date 2026-08-27   # 某天有提醒的任务
node src/cli.js get <id|taskId>               # 查单条
node src/cli.js add "买牛奶" --date 2026-08-27 # 添加任务（返回 taskId）
node src/cli.js update <taskId> --complete true  # 标记完成
node src/cli.js delete <taskId>               # 删除任务
node src/cli.js sync                          # 手动同步
node src/cli.js diagnose                      # Store 结构诊断
```

### App 更新后怎么办？

如果 Todo清单 更新导致 Store 结构变了：

1. 跑 `node src/cli.js diagnose` 看新结构
2. 关注输出里的 `storeModules`（有哪些模块）、`todoFields`（任务字段名）、`categoryFields`（分类字段名）
3. 如果字段名变了（例如 `taskContent` → `title`），改 `todo-client.js` 里对应 `_eval` 中的引用路径
4. 如果 `__vue__` 路径变了（例如升级到 Vue 3），改 `VUEX_EXPR` 常量为 `__vue_app__` 路径

### 如何加新工具

在 `mcp-server.js` 的 `TOOLS` 对象加一条：

```js
'todo.myNewTool': {
  description: '新工具说明',
  inputSchema: {
    type: 'object',
    properties: {
      paramName: { type: 'string', description: '参数说明' },
    },
    required: ['paramName'],
  },
  handler: async (client, params) => {
    await client.connect();
    return await client.myNewMethod(params);
  },
},
```

在 `todo-client.js` 加对应方法：

```js
async myNewMethod(params) {
  const p = JSON.stringify(params);
  return this._eval(
    "(function(){ " +
    "var s=" + VUEX_EXPR + ";" +
    "var p=" + p + ";" +
    "// 你的 Vuex 操作逻辑" +
    "return { ok: true }; " +
    "})()"
  );
},
```

---

## 依赖清单

| 包 | 用途 | 安装 |
|----|------|------|
| `chrome-remote-interface` | CDP WebSocket 客户端封装 | `npm i chrome-remote-interface` |
| `ws` | WebSocket 底层库（被 CDP 库依赖） | `npm i ws` |

**环境要求**：Node.js >= 18（async/await、`Object.entries` 等现代语法）

---

## 与其他方案对比

| 方案 | 原理 | 平台 | 维护成本 | 稳定性 |
|------|------|------|----------|--------|
| **CDP 注入** (本项目) | 连 Electron 进程调 Vuex Store | 仅 Windows 桌面 | 低（字段映射即可） | 高（不走网络） |
| **反向工程 REST API** | MITM 抓包分析后端接口 | 全平台 | 高（签名/风控） | 中（可能被封） |
| **Android 无障碍** | ADB + Accessibility Service | 仅 Android | 高（UI 变化频繁） | 低 |
| **OCR + 模拟点击** | 截图识别 + 鼠标模拟 | Windows | 极高（脆如玻璃） | 极低 |
