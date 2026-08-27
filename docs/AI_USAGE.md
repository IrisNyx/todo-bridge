# Todo Bridge — AI 使用指南

> 面向**调用 MCP 工具的 AI Agent**：本文教你如何正确地查询、创建、修改、删除 Todo清单 任务。
> 如果你是人、想在终端操作，看 [`USAGE.md`](USAGE.md)。

---

## 0. 连接方式

todo-bridge 是**独立进程**，三种接法任选其一：

| 方式 | 命令 | 适合 |
|------|------|------|
| **MCP STDIO** | `node src/mcp-server.js` | Claude Desktop / Cursor / 任意 MCP 客户端 |
| **MCP Streamable HTTP** | `node src/mcp-server.js --http --port 3100` | gateway 等，端点 `POST http://127.0.0.1:3100/mcp` |
| **REST** | 同上 HTTP 进程 | `GET /health`、`GET /tools`、`POST /call/:toolName` |

前置条件：Todo清单.exe 必须以 `--remote-debugging-port=9222` **分离启动**（`start-todo-debug.bat`）。

---

## 1. 工具清单（10 个）

| 工具 | 用途 | 关键点 |
|------|------|--------|
| `todo.ping` | 连接诊断 + 任务/分类总览 | 任何操作前先 ping |
| `todo.getCategories` | 分类列表 | 得到 `categoryId` |
| `todo.getTodos` | 批量查询（日期/无日期/时间范围/提醒筛选） | **默认排除已删除**；每条带 `subtasks` |
| `todo.todayTodos` | **今天所有任务**（本地时区自动过滤） | 查"今天"优先用它，免拉全量 |
| `todo.getTodo` | 查单条 | 用 `taskId` 引用 |
| `todo.createTodo` | 创建（含分类 + 子清单） | **返回 `taskId`** |
| `todo.updateTodo` | 修改 / 标记完成 | 支持 `complete`/`title`/`content`/`date`/`categoryId`/`difficulty` |
| `todo.deleteTodo` | 删除 | 不可逆！ |
| `todo.syncNow` | 云端同步 | 创建/修改/删除后建议调用 |
| `todo.getDiagnostics` | Store 结构诊断 | App 更新后排查字段 |

---

## 2. 你 MUST 遵守的规则

1. **用 `taskId` 引用任务**，不要用数字 `id`。当前 App（v3.14.0）任务**没有数字 `id` 字段**，传数字 id 会优雅返回 not found。taskId 形如 `tid_<userId>_<uuid>_<ts>`。
2. **`getTodos` 默认不含已删除任务**。要查软删的任务，传 `includeDeleted: true`。
3. **任务总量可能很大**，查"今天要做什么"**优先用 `todo.todayTodos`**（自动按当天过滤，不会爆 limit）。其他场景务必加 `limit` 或 `date`/`active`/`categoryId` 等筛选，否则返回海量数据。
4. **子清单（subtasks）格式**：
   - 创建/更新时 `sublist` 是**字符串**：`"- [ ]买菜[end] - [x]拖地"`（`[x]`=已完成，条目间 `[end] - `）。
   - 查询返回的 `subtasks` 是**数组**：`[{ "content": "买菜", "done": false }]`。原始串保留在 `standbyStr2`。
5. **日期时区**：`date: "2026-08-27"` 按本地时区当天解析（不是 UTC）。`from`/`to` 可精确到时刻 `"2026-08-27 09:00"`。
6. **`isError: true`** 表示工具执行失败（如 `todo not found`、`no store`），`content[0].text` 是错误信息。此时任务没发生。
7. 每次 `tools/call` 独立连接，**创建/修改/删除后建议 `todo.syncNow`** 同步到云端。

---

## 3. 调用示例（MCP JSON-RPC）

以下统一用 STDIO/HTTP 的 JSON-RPC 2.0 格式。`arguments` 即工具入参。

### 3.1 先了解全局（ping）

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"todo.ping","arguments":{}}}
```

```json
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"connected\":true,\"totalTodos\":1234,\"activeTodos\":56,\"categories\":[{\"id\":0,\"name\":\"收集箱\",\"color\":\"#xxxxx\"},{\"id\":10001,\"name\":\"你的分类名\",\"color\":\"#xxxxx\"},...],\"userId\":12345}"}]}}
```

> `categories` 里的 `id` 就是该账号的分类 ID，**每次实时返回**，不需要也无法提前知道。

### 3.2 查某天的任务

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"todo.getTodos","arguments":{"date":"2026-08-27","active":true,"limit":10}}}
```

返回的每条任务长这样（已截断）：

```json
{
  "taskId": "tid_<userId>_demo1_1000000000",
  "taskContent": "阅读30分钟",
  "complete": false,
  "delete": false,
  "todoTime": 1787760000000,
  "dayStart": 1787760000000,
  "standbyInt1": 10001,
  "standbyStr2": "- [ ]读书[end] - [x]整理笔记",
  "subtasks": [
    { "content": "读书", "done": false },
    { "content": "整理笔记", "done": true }
  ]
}
```

### 3.3 今天所有任务（推荐，自动按本地时区过滤）

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"todo.todayTodos","arguments":{}}}
```

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"[{\"taskId\":\"tid_...\",\"taskContent\":\"阅读30分钟\",\"complete\":false,\"subtasks\":[{\"content\":\"读书\",\"done\":false}]},...]"}]}}
```

只看未完成：`{"active": true}`；按分类：`{"categoryId": 10001}`（用 `todo.getCategories` 拿）；含已删除：`{"includeDeleted": true}`。

### 3.4 无日期 / 时间范围 / 提醒筛选

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"todo.getTodos","arguments":{"noDate":true,"active":true}}}
```

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"todo.getTodos","arguments":{"from":"2026-08-27 09:00","to":"2026-08-27 12:00"}}}
```

```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"todo.getTodos","arguments":{"reminderDate":"2026-08-27"}}}
```

### 3.5 创建任务（带分类 + 子清单 + 日期 + 提醒）

```json
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"todo.createTodo","arguments":{"title":"周末大扫除","categoryId":10001,"date":"2026-08-30","reminderTime":"09:00","sublist":"- [ ]擦窗[end] - [ ]拖地[end] - [x]扔垃圾"}}}
```

```json
{"jsonrpc":"2.0","id":6,"result":{"content":[{"type":"text","text":"{\"ok\":true,\"taskId\":\"tid_<userId>_demo2_1000000000\",\"id\":null,\"taskContent\":\"周末大扫除\",\"categoryId\":10001,\"todoTime\":1787673600000,\"reminderTime\":1787720400000}"}]}}
```

> ⚠️ **保存返回的 `taskId`**。它是后续 `getTodo`/`updateTodo`/`deleteTodo` 的唯一凭据。

### 3.6 标记完成 / 修改

```json
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"todo.updateTodo","arguments":{"todoId":"tid_<userId>_demo2_1000000000","complete":true}}}
```

```json
{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"todo.updateTodo","arguments":{"todoId":"tid_<userId>_demo2_1000000000","content":"改一下备注","date":"2026-08-31"}}}
```

### 3.7 删除（先查确认）

```json
{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"todo.getTodo","arguments":{"todoId":"tid_<userId>_demo2_1000000000"}}}
```

```json
{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"todo.deleteTodo","arguments":{"todoId":"tid_<userId>_demo2_1000000000"}}}
```

### 3.8 同步

```json
{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"todo.syncNow","arguments":{}}}
```

---

## 4. 完整工作流示例（照着做）

**场景：用户说「看看我今天的任务，把买菜标成完成，再加一条带子清单的『周末大扫除』」**

```
① todo.getTodos {date: 今天, active: true}      → 找到「买菜」的 taskId
② todo.updateTodo {todoId: <买菜taskId>, complete: true}
③ todo.createTodo {title: "周末大扫除", categoryId: <先用 getCategories 拿到的分类ID>, sublist: "- [ ]擦窗[end] - [ ]拖地"}
④ todo.syncNow
```

**场景：用户说「上周有没有没做完的」**

```
① todo.getTodos {from: 上周一, to: 上周末, active: true}   → 得到每条的 subtasks，done:false 的子项即未完成
```

**场景：用户说「那个带三个子任务的任务叫啥来着」**

```
① todo.getTodos {active: true, limit: 50}                 → 找 subtasks.length >= 3 的任务
② todo.getTodo {todoId: <taskId>}                          → 看完整详情
```

---

## 5. 错误排查

| 症状 | 含义 | 处理 |
|------|------|------|
| `isError: true`, text `todo not found for id=...` | taskId/id 不存在（或该 id 是数字但 store 无此字段） | 先 `getTodos` 确认 taskId |
| `isError: true`, text `no store` | App 未启动 / 页面没加载完 | 确认 App 以 CDP 9222 分离启动，稍后重试 |
| `CDP.List timeout` | 9222 端口没开 | `start-todo-debug.bat` 重启 App |
| `__error__` 出现在正常返回里 | 工具内部错误（非 MCP 层） | 看错误信息；必要时 `todo.getDiagnostics` |

**注意**：`todo.getDiagnostics` 返回 Store 模块/字段/action/mutation 列表。如果 App 更新后字段名变了（例如 `taskContent`→`title`），用它确认新结构再调整调用参数。
