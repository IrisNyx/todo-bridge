# Todo Bridge — 使用指南（人类版）

> 面向**在终端操作的人**：怎么启动、怎么用 CLI 管理 Todo清单 任务。
> 如果你是 AI Agent、要调用 MCP 工具，看 [`AI_USAGE.md`](AI_USAGE.md)。

---

## 1. 快速开始

### 1.1 启动 Todo清单（必须分离启动）

> ⚠️ **不要**从 git-bash / PowerShell 直接 `./Todo清单.exe`——进程会立即干净退出。
> ⚠️ 也不要直接传 `--remote-debugging-port` —— git-bash 会改写参数导致 `bad option`。

```bat
cd /d <todo-bridge 目录>    :: 改成你的实际目录
start-todo-debug.bat        :: 内部用 start 分离启动，带 CDP 9222
```

等价手动方式：`explorer.exe "<你的 Todo清单.exe 路径>"`（不带 CDP 参数则需另开调试端口，推荐直接用 bat）。

> `start-todo-debug.bat` 依赖环境变量 `TODO_LIST_EXE` 指向你的 `Todo清单.exe`（见 `README.md` 环境变量配置）。

### 1.2 确认就绪

```bash
node src/cli.js doctor      # 环境诊断（exe 路径 / CDP 端口 / 进程）
node src/cli.js ping        # 连接 + 任务总数 + 分类列表
```

看到 `connected: true`、分类列表即就绪。

---

## 2. CLI 命令速查

```bash
node src/cli.js doctor                # 环境诊断
node src/cli.js ping                  # 连接 + 总览
node src/cli.js categories            # 列出所有分类（拿 categoryId）
node src/cli.js list [筛选]            # 查询任务（见 §3）
node src/cli.js today [--active]       # 今天所有任务（本地时区，免拉全量）
node src/cli.js get <id|taskId>       # 查单条任务
node src/cli.js add "标题" [选项]       # 创建任务
node src/cli.js update <id> [选项]     # 修改 / 标记完成
node src/cli.js delete <id|taskId>    # 删除任务（不可逆！）
node src/cli.js sync                  # 云端同步
node src/cli.js mcp [--http] [--port N]   # 启动 MCP Server
```

---

## 3. 查询示例

```bash
# 今天所有任务（推荐，免拉全量）/ 只看未完成
node src/cli.js today
node src/cli.js today --active

# 某天 / 无日期的任务
node src/cli.js list --date 2026-08-27 --active
node src/cli.js list --no-date --active --limit 20

# 某天某个时间段（精确到时刻）
node src/cli.js list --from "2026-08-27 09:00" --to "2026-08-27 18:00"

# 提醒筛选 / 含已删除
node src/cli.js list --reminder-date 2026-08-27
node src/cli.js list --date 2026-08-27 --include-deleted

# 按分类
node src/cli.js list --categoryId 12345 --active --limit 30
```

每条返回的任务都带 `subtasks` 数组（子清单已解析），例如：

```json
{
  "taskContent": "阅读30分钟",
  "subtasks": [
    { "content": "读书", "done": false },
    { "content": "整理笔记", "done": true }
  ]
}
```

---

## 4. 创建 / 修改 / 删除

### 4.1 创建普通任务

```bash
node src/cli.js add "买菜" --difficulty 2 --date 2026-08-27 --reminder 09:00 --categoryId 12345 --content "有机的"
```

返回里的 `taskId` 是后续操作唯一凭据，**记下来**。

### 4.2 创建带子清单的任务

```bash
# 子清单格式：每条 "- [ ]内容"（[x]=已完成），条目间用 "[end] - " 分隔
node src/cli.js add "周末大扫除" --categoryId 12345 --sublist "- [ ]擦窗[end] - [x]扔垃圾[end] - [ ]拖地"
```

> bash 里整个 `--sublist` 值要加引号，否则 `[` `]` 会被当成通配符。

### 4.3 标记完成 / 改内容

```bash
node src/cli.js update tid_xxx --complete true          # 标记完成
node src/cli.js update tid_xxx --complete false         # 取消完成
node src/cli.js update tid_xxx --content "新备注" --date 2026-08-28
node src/cli.js update tid_xxx --categoryId 12345      # 改分类
```

### 4.4 删除（不可逆，先 get 确认）

```bash
node src/cli.js get tid_xxx
node src/cli.js delete tid_xxx
```

### 4.5 同步

```bash
node src/cli.js sync
```

---

## 5. 分类 ID 怎么来？

分类 ID 是你账号的**动态数据**，用 `categories` 命令实时获取（不要写死、不要猜）：

```bash
node src/cli.js categories
```

输出 `[{categoryId, categoryName, categoryColor}, ...]`，用返回的 `categoryId` 传给 `--categoryId`。`0` 是默认"收集箱"。

> 本指南示例里的 `12345` 只是占位符，请替换成你账号实际返回的 ID。

---

## 6. REST / MCP 手动试一把（可选）

起 HTTP 模式：

```bash
node src/mcp-server.js --http --port 3100
```

```bash
curl http://127.0.0.1:3100/health                        # 健康检查
curl http://127.0.0.1:3100/tools                          # 工具列表
curl -X POST http://127.0.0.1:3100/call/todo.ping -H "Content-Type: application/json" -d '{}'
curl -X POST http://127.0.0.1:3100/call/todo.getTodos -H "Content-Type: application/json" -d '{"date":"2026-08-27","active":true,"limit":5}'
```

MCP Streamable HTTP 端点：`POST http://127.0.0.1:3100/mcp`（标准 MCP JSON-RPC，`initialize` 会回 `Mcp-Session-Id`，不带头也能用）。

---

## 7. 注册到 AI 客户端

### Claude Desktop（`claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "todo-bridge": {
      "command": "node",
      "args": ["<todo-bridge 绝对路径>\\src\\mcp-server.js"]
    }
  }
}
```

### Cursor / 其他 MCP 客户端

- **STDIO**：同上，command `node`，args 指向 `src/mcp-server.js`。
- **HTTP**：`node src/mcp-server.js --http --port 3100`，客户端配 `transport: streamable-http`、`url: http://127.0.0.1:3100/mcp`。

### gateway（如用）

在 gateway 的 MCP server 配置里注册 `transport: "streamable"`，URL 指到 `http://127.0.0.1:3100/mcp`。（todo-bridge 是独立服务，**无需改动 gateway 本体配置**。）

---

## 8. 常见问题

| 问题 | 解决 |
|------|------|
| 启动 exe 秒退 | 必须分离启动（`start-todo-debug.bat` / 快捷方式 / `explorer.exe`） |
| `bad option: --remote-debugging-port` | 别在 git-bash 直接传 `--xxx`，用 bat |
| `CDP.List timeout` | 9222 没开，重新 `start-todo-debug.bat` |
| `ping` 返回 `no store` | App 窗口刚开还没加载完，稍等重试 |
| 查不到刚建的任务 | 已建任务无 `id` 字段；用返回的 `taskId` 查；删了也会被 `list` 默认过滤 |
