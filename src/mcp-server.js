#!/usr/bin/env node
/**
 * mcp-server.js — Todo Bridge MCP Server
 *
 * 三入口，共享同一套 TOOLS 注册表：
 *   STDIO（默认）          → 标准 MCP over STDIO，供 Claude Desktop / Cursor 等集成
 *   HTTP（--http --port）  → 双端点：
 *       POST /mcp          MCP Streamable HTTP（gateway transport: streamable/http 可连，sessionless 兼容）
 *       GET  /health       REST 健康检查
 *       GET  /tools        REST 工具列表
 *       POST /call/:name   REST 调用工具
 *       GET  /             服务信息
 */

const http = require('http');
const crypto = require('crypto');
const TodoClient = require('./todo-client');
const { CONFIG } = require('./config');

const VERSION = '1.1.0';

// ─── 工具定义 ──────────────────────────────────────
const TOOLS = {
  'todo.ping': {
    description: '测试与 Todo清单 的连接（CDP 端口是否可达，Vuex Store 是否可操作），返回任务总数/活跃数/分类/用户ID',
    inputSchema: { type: 'object', properties: {} },
    handler: async (client) => {
      await client.connect();
      return await client.ping();
    },
  },
  'todo.getCategories': {
    description: '获取 Todo清单 中的所有分类/列表（categoryId/categoryName/categoryColor 等）',
    inputSchema: { type: 'object', properties: {} },
    handler: async (client) => {
      await client.connect();
      return await client.getCategories();
    },
  },
  'todo.getTodos': {
    description: '获取 Todo清单 任务，可按活跃/分类/计划日期/无日期/时间范围/提醒时间筛选。date 为 YYYY-MM-DD；from/to 为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM（对计划日期 todoTime 过滤）；noDate=true 返回无计划日期的任务；reminderDate/reminderFrom/reminderTo 对提醒时间过滤',
    inputSchema: {
      type: 'object',
      properties: {
        active:        { type: 'boolean', description: '仅返回活跃（未完成未删除）任务' },
        includeDeleted:{ type: 'boolean', description: 'true=同时返回已删除(软删)任务；默认排除已删除' },
        categoryId:    { type: 'number', description: '按分类 ID 筛选' },
        limit:         { type: 'number', description: '返回条数上限' },
        date:          { type: 'string', description: '计划日期 YYYY-MM-DD，返回当天任务' },
        noDate:        { type: 'boolean', description: 'true=仅返回无计划日期的任务' },
        from:          { type: 'string', description: '计划时间范围起点（YYYY-MM-DD 或 YYYY-MM-DD HH:MM）' },
        to:            { type: 'string', description: '计划时间范围终点（闭区间；只传日期时到当日 23:59:59）' },
        reminderDate:  { type: 'string', description: '提醒日期 YYYY-MM-DD，返回当天有提醒的任务' },
        reminderFrom:  { type: 'string', description: '提醒时间范围起点' },
        reminderTo:    { type: 'string', description: '提醒时间范围终点' },
      },
    },
    handler: async (client, params) => {
      await client.connect();
      return await client.getTodos(params || {});
    },
  },
  'todo.todayTodos': {
    description: '获取今天（本地时区）计划的所有任务，自动按当天过滤，避免无筛选拉全量（3500+）。可传 active 只看未完成、includeDeleted 含已删除、categoryId 按分类、limit 兜底',
    inputSchema: {
      type: 'object',
      properties: {
        active:         { type: 'boolean', description: 'true=仅返回未完成未删除的任务' },
        includeDeleted: { type: 'boolean', description: 'true=同时返回已删除(软删)任务；默认排除' },
        categoryId:     { type: 'number', description: '按分类 ID 筛选' },
        limit:          { type: 'number', description: '返回条数上限' },
      },
    },
    handler: async (client, params) => {
      await client.connect();
      return await client.todayTodos(params || {});
    },
  },
  'todo.getTodo': {
    description: '按 id（数字）或 taskId（字符串）查询单条任务',
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: ['number', 'string'], description: '任务 ID（数字 id 或 taskId 字符串）' },
      },
      required: ['todoId'],
    },
    handler: async (client, params) => {
      await client.connect();
      return await client.getTodo(params.todoId);
    },
  },
  'todo.createTodo': {
    description: '在 Todo清单 中创建一条新任务，返回新建任务的 taskId（同步前可用它做后续更新/删除）',
    inputSchema: {
      type: 'object',
      properties: {
        title:        { type: 'string', description: '任务标题（必填）' },
        content:      { type: 'string', description: '任务备注/详情' },
        categoryId:   { type: 'number', description: '所属分类 ID（收集箱=0）' },
        difficulty:   { type: 'number', description: '难度/工作量（1-低, 2-中, 3-高）' },
        date:         { type: 'string', description: '计划日期，如 2026-08-27' },
        reminderTime: { type: 'string', description: '提醒时间，如 09:00（与 date 合成；无 date 默认今天）' },
        sublist:      { type: 'string', description: '子任务/清单，格式：每条 "- [ ]子任务" 或 "- [x]已完成子任务"，条目间用 "[end] - " 分隔。示例："- [ ]买牛奶[end] - [x]拖地"（[x]=已完成）' },
      },
      required: ['title'],
    },
    handler: async (client, params) => {
      await client.connect();
      return await client.createTodo(params);
    },
  },
  'todo.updateTodo': {
    description: '修改任务或标记完成/未完成。传 todoId + 需改的字段（complete 布尔 / title / content / date / reminderTime / categoryId / difficulty 均可）',
    inputSchema: {
      type: 'object',
      properties: {
        todoId:       { type: ['number', 'string'], description: '任务 ID（数字 id 或 taskId 字符串）' },
        complete:     { type: 'boolean', description: '标记完成/未完成' },
        title:        { type: 'string', description: '新标题' },
        content:      { type: 'string', description: '新备注/详情' },
        date:         { type: 'string', description: '计划日期 YYYY-MM-DD' },
        reminderTime: { type: 'string', description: '提醒时间 HH:MM' },
        categoryId:   { type: 'number', description: '新分类 ID' },
        difficulty:   { type: 'number', description: '难度/工作量（1-3）' },
      },
      required: ['todoId'],
    },
    handler: async (client, params) => {
      await client.connect();
      const { todoId, ...patch } = params || {};
      return await client.updateTodo(todoId, patch);
    },
  },
  'todo.deleteTodo': {
    description: '删除 Todo清单 中的一条任务（不可逆，服务端同步后无法恢复）。可传数字 id 或 taskId',
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: ['number', 'string'], description: '任务 ID（数字 id 或 taskId 字符串）' },
      },
      required: ['todoId'],
    },
    handler: async (client, params) => {
      await client.connect();
      return await client.deleteTodo(params.todoId);
    },
  },
  'todo.syncNow': {
    description: '触发 Todo清单 立即同步到云端（幂等）',
    inputSchema: { type: 'object', properties: {} },
    handler: async (client) => {
      await client.connect();
      return await client.syncNow();
    },
  },
  'todo.getDiagnostics': {
    description: '获取 Vuex Store 诊断信息（模块/字段/action/mutation，用于 App 更新后排查字段变化）',
    inputSchema: { type: 'object', properties: {} },
    handler: async (client) => {
      await client.connect();
      return await client.getDiagnostics();
    },
  },
};

// ─── 创建 TodoClient 实例 ─────────────────────────
function createClient() {
  return new TodoClient({ cdpPort: CONFIG.cdpPort, timeout: CONFIG.timeout });
}

function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));
}

// ─── MCP 消息处理（STDIO / HTTP 共用）─────────────
// send(resp) ：resp 为 JSON-RPC 响应对象；notification 时 resp 为 null，双方运输层不回包
async function handleMCPMessage(msg, send) {
  if (!msg || typeof msg !== 'object') return send(null);
  const { id, method, params } = msg;
  if (id === undefined) return send(null); // notification 不响应
  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'todo-bridge', version: VERSION },
          },
        });

      case 'notifications/initialized':
        return send(null);

      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });

      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: toolList() } });

      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const tool = TOOLS[name];
        if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } });
        const client = createClient();
        let result = null;
        let toolError = null;
        try {
          result = await tool.handler(client, args || {});
          if (result && typeof result === 'object' && result.__error__ !== undefined) {
            toolError = result.__error__;
          }
        } catch (err) {
          toolError = err && err.message ? err.message : String(err);
        } finally {
          try { await client.close(); } catch (e) {}
        }
        if (toolError !== null) {
          return send({
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: typeof toolError === 'string' ? toolError : JSON.stringify(toolError) }],
              isError: true,
            },
          });
        }
        return send({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        });
      }

      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method: ' + method } });
    }
  } catch (err) {
    return send({ jsonrpc: '2.0', id, error: { code: -32603, message: err && err.message ? err.message : String(err) } });
  }
}

// ─── STDIO MCP 模式 ───────────────────────────────
function startStdioMode() {
  let chain = Promise.resolve();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      // 串行化：避免并发请求响应乱序
      chain = chain.then(() =>
        handleMCPMessage(msg, (resp) => {
          if (resp !== null) process.stdout.write(JSON.stringify(resp) + '\n');
        })
      ).catch(() => {});
    }
  });
  process.stderr.write('[Todo Bridge MCP v' + VERSION + '] STDIO mode ready\n');
}

function sendJSON(res, code, obj, headers) {
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  res.writeHead(code, h);
  res.end(JSON.stringify(obj));
}

// ─── HTTP MCP + REST 模式 ─────────────────────────
function startHttpMode(port) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, 'http://' + req.headers.host || 'http://127.0.0.1');
    const path = url.pathname;

    // ── MCP Streamable HTTP ──
    if (req.method === 'POST' && path === CONFIG.httpPath) {
      let body = '';
      req.on('data', (c) => { if (body.length < 4 * 1024 * 1024) body += c; });
      req.on('end', async () => {
        let msg;
        try { msg = JSON.parse(body); }
        catch (e) { return sendJSON(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
        const isInit = msg && msg.method === 'initialize';
        const sessionId = isInit ? crypto.randomUUID() : (req.headers['mcp-session-id'] || '');
        try {
          await handleMCPMessage(msg, (resp) => {
            if (resp === null) { res.writeHead(202, { 'Content-Type': 'application/json' }); return res.end(); }
            const headers = {};
            if (isInit) headers['Mcp-Session-Id'] = sessionId;
            sendJSON(res, 200, resp, headers);
          });
        } catch (e) {
          sendJSON(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message } });
        }
      });
      return;
    }

    // ── REST ──
    if (req.method === 'GET' && path === '/health') {
      return sendJSON(res, 200, { status: 'ok', version: VERSION, tools: Object.keys(TOOLS) });
    }
    if (req.method === 'GET' && path === '/tools') {
      return sendJSON(res, 200, { tools: toolList() });
    }
    if (req.method === 'GET' && path === '/') {
      return sendJSON(res, 200, {
        name: 'todo-bridge', version: VERSION,
        endpoints: {
          mcp: 'POST ' + CONFIG.httpPath + '  (MCP Streamable HTTP)',
          health: 'GET /health',
          tools: 'GET /tools',
          call: 'POST /call/:toolName',
        },
      });
    }
    if (req.method === 'POST' && path.startsWith('/call/')) {
      const toolName = decodeURIComponent(path.slice(6));
      const tool = TOOLS[toolName];
      if (!tool) return sendJSON(res, 404, { error: 'Unknown tool: ' + toolName });
      let body = '';
      req.on('data', (c) => { if (body.length < 4 * 1024 * 1024) body += c; });
      req.on('end', async () => {
        let params = {};
        try { params = body ? JSON.parse(body) : {}; } catch (e) { /* keep empty */ }
        const client = createClient();
        let result = null;
        let err = null;
        try {
          result = await tool.handler(client, params);
          if (result && typeof result === 'object' && result.__error__ !== undefined) err = result.__error__;
        } catch (e) {
          err = e && e.message ? e.message : String(e);
        } finally {
          try { await client.close(); } catch (e) {}
        }
        if (err !== null) return sendJSON(res, 200, { ok: false, error: err });
        sendJSON(res, 200, { ok: true, result });
      });
      return;
    }

    sendJSON(res, 404, { error: 'not found' });
  });

  server.listen(port, '127.0.0.1', () => {
    process.stderr.write('[Todo Bridge MCP v' + VERSION + '] HTTP mode on http://127.0.0.1:' + port + '\n');
    process.stderr.write('[Todo Bridge MCP] MCP Streamable: POST ' + CONFIG.httpPath + ' | REST: GET /health /tools | POST /call/:toolName\n');
  });
  return server;
}

// ─── Main ─────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--http')) {
    const pi = args.indexOf('--port');
    const port = pi !== -1 ? parseInt(args[pi + 1]) : CONFIG.httpPort;
    startHttpMode(port);
  } else {
    startStdioMode();
  }
}

module.exports = { VERSION, TOOLS, createClient, toolList, handleMCPMessage, startStdioMode, startHttpMode };
