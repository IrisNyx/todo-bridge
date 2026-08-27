'use strict';
/**
 * mcp.test.js — 协议层单测。mock ./todo-client，驱动 handleMCPMessage 与 HTTP /mcp 端点。
 */
const { test } = require('node:test');
const assert = require('node:assert');

// mock ./todo-client 后再 require mcp-server
const MockTodoClient = class {
  constructor() {}
  async connect() { return this; }
  async close() {}
  async ping() { return { connected: true, totalTodos: 3, activeTodos: 2, categories: [], userId: 1 }; }
  async getTodos(f) { if (f && f.fail) return { __error__: 'no store' }; return [{ id: 1, taskId: 'tid_1', taskContent: 'x' }]; }
  async getCategories() { return []; }
  async createTodo(p) { return { ok: true, taskId: 'tid_new' }; }
  async getTodo(id) { return { found: true, todo: { id: 1 } }; }
  async updateTodo(id, patch) { return { ok: true, taskId: id, patch }; }
  async deleteTodo(id) { return { ok: true }; }
  async syncNow() { return { ok: true, synced: true }; }
  async getDiagnostics() { return { vueVersion: 2 }; }
};

const todoClientPath = require.resolve('../src/todo-client');
require.cache[todoClientPath] = { id: todoClientPath, filename: todoClientPath, loaded: true, exports: MockTodoClient };
const mcp = require('../src/mcp-server');

function capture() {
  const arr = [];
  const send = (r) => arr.push(r);
  return { arr, send };
}

test('initialize 返回协议版本与能力', async () => {
  const { arr, send } = capture();
  await mcp.handleMCPMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, send);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].result.protocolVersion, '2024-11-05');
  assert.ok(arr[0].result.capabilities.tools);
  assert.equal(arr[0].result.serverInfo.name, 'todo-bridge');
});

test('tools/list 包含新工具', async () => {
  const { arr, send } = capture();
  await mcp.handleMCPMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, send);
  const names = arr[0].result.tools.map((t) => t.name);
  for (const n of ['todo.ping', 'todo.getTodos', 'todo.getTodo', 'todo.createTodo', 'todo.updateTodo', 'todo.deleteTodo']) {
    assert.ok(names.includes(n), '应有 ' + n);
  }
});

test('tools/call 正常返回 content 文本', async () => {
  const { arr, send } = capture();
  await mcp.handleMCPMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'todo.ping', arguments: {} } },
    send
  );
  assert.equal(arr[0].result.content[0].type, 'text');
  assert.ok(arr[0].result.content[0].text.includes('connected'));
  assert.ok(!arr[0].result.isError);
});

test('tools/call 工具级 __error__ 标 isError:true', async () => {
  const { arr, send } = capture();
  await mcp.handleMCPMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'todo.getTodos', arguments: { fail: true } } },
    send
  );
  assert.equal(arr[0].result.isError, true);
  assert.ok(arr[0].result.content[0].text.includes('no store'));
});

test('tools/call 未知工具 → -32601', async () => {
  const { arr, send } = capture();
  await mcp.handleMCPMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }, send);
  assert.equal(arr[0].error.code, -32601);
});

test('ping 方法返回空 result', async () => {
  const { arr, send } = capture();
  await mcp.handleMCPMessage({ jsonrpc: '2.0', id: 5, method: 'ping' }, send);
  assert.deepEqual(arr[0].result, {});
});

test('notifications/initialized 不回响应', async () => {
  const { arr, send } = capture();
  await mcp.handleMCPMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, send);
  // send(null) = 通知不回包（transport 层对 null 不写响应）
  assert.equal(arr.length, 1);
  assert.equal(arr[0], null);
});

test('未知 method → -32601', async () => {
  const { arr, send } = capture();
  await mcp.handleMCPMessage({ jsonrpc: '2.0', id: 6, method: 'bogus/method' }, send);
  assert.equal(arr[0].error.code, -32601);
});

// ── HTTP /mcp 端点 ──
test('HTTP /mcp 走完 initialize/tools/list/tools/call + REST', async () => {
  const server = mcp.startHttpMode(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    // initialize
    const r1 = await fetch(base + '/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.result.protocolVersion, '2024-11-05');
    assert.ok(r1.headers.get('Mcp-Session-Id'), 'initialize 应返回 session id');

    // tools/list 带 session
    const r2 = await fetch(base + '/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': r1.headers.get('Mcp-Session-Id') },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const j2 = await r2.json();
    assert.ok(j2.result.tools.some((t) => t.name === 'todo.getTodos'));

    // tools/call 不带 session（sessionless 兼容）
    const r3 = await fetch(base + '/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'todo.ping', arguments: {} } }),
    });
    const j3 = await r3.json();
    assert.ok(j3.result.content[0].text.includes('connected'));

    // notifications → 202
    const r4 = await fetch(base + '/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(r4.status, 202);

    // REST /call/:toolName
    const r5 = await fetch(base + '/call/todo.ping', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const j5 = await r5.json();
    assert.equal(j5.ok, true);
    assert.ok(j5.result.connected);

    // REST /health
    const r6 = await fetch(base + '/health');
    const j6 = await r6.json();
    assert.ok(Array.isArray(j6.tools));

    // REST 未知工具 → 404
    const r7 = await fetch(base + '/call/nope', { method: 'POST', body: '{}' });
    assert.equal(r7.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
