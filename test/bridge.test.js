'use strict';
/**
 * bridge.test.js — 用 vm 伪造 document/#app/__vue__.$store，直接跑 todo-client.js 注入的真实表达式。
 * 零外部依赖，无需 CDP / 无需 Todo App 运行。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const TodoClient = require('../src/todo-client');

function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function localTs(dayStr, hm) {
  return new Date(dayStr + 'T' + (hm || '00:00') + ':00').getTime();
}

// ── 伪造 CDP：把注入表达式跑在 vm 沙箱里 ──
class FakeCdp {
  constructor(sandbox) {
    this.sandbox = sandbox;
    this.Runtime = { enable: async () => {}, evaluate: (o) => this._evaluate(o) };
  }
  async close() {}
  async _evaluate(opts) {
    try {
      let value = vm.runInNewContext(opts.expression, this.sandbox, { timeout: 3000 });
      if (opts.awaitPromise) value = await value;
      return { result: { value } };
    } catch (e) {
      return { exceptionDetails: { text: e.message, exception: { description: e.stack } } };
    }
  }
}

// ── 伪造 Vuex Store ──
function makeSandbox(todos, categories, authUser) {
  todos = todos || [];
  const commits = [];
  const store = {
    state: {
      todo: { todoList: todos },
      category: { list: categories || [] },
      auth: { user: authUser || { id: 12345 } },
    },
    _actions: {
      'todo/addTodo': [function addTodo(p) {
        const taskId = 'tid_new_' + Math.floor(Math.random() * 1e9);
        const todo = {
          id: null, taskId, taskContent: p.todoContent || '', taskDescribe: p.todoDescription || '',
          todoTime: p.todoDate || 0, reminderTime: p.todoReminderTime || 0,
          complete: false, delete: false, standbyInt1: p.categoryId || 0,
          snowAdd: 0, snowAssess: p.todoDifficultyLevel || 0, status: 'add',
          // 真实 store：addTodo 把 todoSublist 写入 standbyStr2
          standbyStr2: p.todoSublist || null,
        };
        if (p.addToTop) todos.unshift(todo); else todos.push(todo);
        return { ok: true, taskId, taskContent: todo.taskContent };
      }],
    },
    _mutations: {
      'todo/deleteTodo': [() => {}],
      'todo/updateTodo': [() => {}],
    },
    commit: (type, payload) => {
      commits.push({ type, payload });
      if (type === 'todo/updateTodo') {
        const t = todos.find((x) => x.taskId === payload.taskId);
        if (t) Object.assign(t, payload);
      } else if (type === 'todo/deleteTodo') {
        const i = todos.indexOf(payload);
        if (i >= 0) todos.splice(i, 1);
      }
    },
  };
  const sandbox = { document: { querySelector: () => ({ __vue__: { $store: store } }) } };
  return { sandbox, store, commits };
}

function makeClient(sandbox) {
  const client = new TodoClient({ cdpPort: 9222 });
  client._client = new FakeCdp(sandbox);
  return client;
}

// ── 测试 ──
test('getTodos: date 当天过滤', async () => {
  const today = dateStr(0);
  const todos = [
    { id: 1, taskId: 'tid_a', taskContent: '今天', todoTime: localTs(today, '09:00'), reminderTime: localTs(today, '09:00'), complete: false, delete: false, standbyInt1: 5 },
    { id: 2, taskId: 'tid_b', taskContent: '无日期', todoTime: 0, complete: false, delete: false, standbyInt1: 0 },
    { id: 3, taskId: 'tid_c', taskContent: '昨天', todoTime: localTs(dateStr(-1), '10:00'), complete: false, delete: false, standbyInt1: 0 },
    { id: 4, taskId: 'tid_d', taskContent: '今天已完成', todoTime: localTs(today, '14:00'), complete: true, delete: false, standbyInt1: 0 },
  ];
  const { sandbox } = makeSandbox(todos);
  const client = makeClient(sandbox);

  const all = await client.getTodos({ date: today });
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((t) => t.taskId).sort(), ['tid_a', 'tid_d']);

  const active = await client.getTodos({ date: today, active: true });
  assert.equal(active.length, 1);
  assert.equal(active[0].taskId, 'tid_a');
});

test('getTodos: noDate 过滤', async () => {
  const today = dateStr(0);
  const todos = [
    { id: 1, taskId: 'tid_a', taskContent: '有日期', todoTime: localTs(today, '09:00'), complete: false, delete: false },
    { id: 2, taskId: 'tid_b', taskContent: '无日期', todoTime: 0, complete: false, delete: false },
    { id: 3, taskId: 'tid_c', taskContent: '无日期2', todoTime: undefined, complete: false, delete: false },
  ];
  const { sandbox } = makeSandbox(todos);
  const client = makeClient(sandbox);
  const r = await client.getTodos({ noDate: true });
  assert.deepEqual(r.map((t) => t.taskId).sort(), ['tid_b', 'tid_c']);
});

test('getTodos: from/to 时刻范围 + categoryId', async () => {
  const today = dateStr(0);
  const todos = [
    { id: 1, taskId: 'tid_a', taskContent: '上午', todoTime: localTs(today, '09:00'), complete: false, delete: false, standbyInt1: 7 },
    { id: 2, taskId: 'tid_b', taskContent: '下午', todoTime: localTs(today, '14:00'), complete: false, delete: false, standbyInt1: 7 },
    { id: 3, taskId: 'tid_c', taskContent: '别的分类', todoTime: localTs(today, '10:00'), complete: false, delete: false, standbyInt1: 9 },
  ];
  const { sandbox } = makeSandbox(todos);
  const client = makeClient(sandbox);
  const r = await client.getTodos({ from: today + ' 08:00', to: today + ' 12:00', categoryId: 7 });
  assert.deepEqual(r.map((t) => t.taskId), ['tid_a']);
});

test('getTodos: reminderDate 过滤', async () => {
  const today = dateStr(0);
  const todos = [
    { id: 1, taskId: 'tid_a', taskContent: '今天有提醒', todoTime: 0, reminderTime: localTs(today, '09:00'), complete: false, delete: false },
    { id: 2, taskId: 'tid_b', taskContent: '明天有提醒', todoTime: 0, reminderTime: localTs(dateStr(1), '09:00'), complete: false, delete: false },
  ];
  const { sandbox } = makeSandbox(todos);
  const client = makeClient(sandbox);
  const r = await client.getTodos({ reminderDate: today });
  assert.deepEqual(r.map((t) => t.taskId), ['tid_a']);
});

test('todayTodos: 自动按本地时区今天过滤，无需传日期', async () => {
  const today = dateStr(0);
  const todos = [
    { id: 1, taskId: 'tid_t1', taskContent: '今天要做', todoTime: localTs(today, '09:00'), complete: false, delete: false },
    { id: 2, taskId: 'tid_t2', taskContent: '明天再做', todoTime: localTs(dateStr(1), '09:00'), complete: false, delete: false },
    { id: 3, taskId: 'tid_t3', taskContent: '今天已完成', todoTime: localTs(today, '14:00'), complete: true, delete: false },
  ];
  const { sandbox } = makeSandbox(todos);
  const client = makeClient(sandbox);

  const all = await client.todayTodos({});
  assert.deepEqual(all.map((t) => t.taskId).sort(), ['tid_t1', 'tid_t3'], '今天所有（含已完成）');

  const active = await client.todayTodos({ active: true });
  assert.deepEqual(active.map((t) => t.taskId), ['tid_t1'], 'active 只留未完成');

  const cat = await client.todayTodos({ categoryId: 99 });
  assert.equal(cat.length, 0);
});

test('getTodos: 默认排除已删除任务（includeDeleted 可覆盖）', async () => {
  const today = dateStr(0);
  const todos = [
    { taskId: 'tid_a', taskContent: '活着的', todoTime: localTs(today, '00:00'), complete: false, delete: false },
    { taskId: 'tid_b', taskContent: '已删除', todoTime: localTs(today, '00:00'), complete: false, delete: true },
  ];
  const { sandbox } = makeSandbox(todos);
  const client = makeClient(sandbox);
  const r = await client.getTodos({ date: today });
  assert.deepEqual(r.map((t) => t.taskId), ['tid_a']);
  const withDel = await client.getTodos({ date: today, includeDeleted: true });
  assert.equal(withDel.length, 2);
});

test('getTodos: date 用 dayStart 归组（todoTime=0 但 dayStart=当天仍命中）', async () => {
  const today = dateStr(0);
  const start = localTs(today, '00:00');
  const todos = [
    { taskId: 'tid_a', taskContent: '仅dayStart', todoTime: 0, dayStart: start, complete: false, delete: false },
    { taskId: 'tid_b', taskContent: '有todoTime', todoTime: localTs(today, '07:00'), complete: false, delete: false },
    { taskId: 'tid_c', taskContent: '别天', todoTime: localTs(dateStr(1), '00:00'), dayStart: localTs(dateStr(1), '00:00'), complete: false, delete: false },
  ];
  const { sandbox } = makeSandbox(todos);
  const client = makeClient(sandbox);
  const r = await client.getTodos({ date: today });
  assert.deepEqual(r.map((t) => t.taskId).sort(), ['tid_a', 'tid_b']);
});

test('getTodos: noDate 排除有 dayStart 的任务', async () => {
  const today = dateStr(0);
  const start = localTs(today, '00:00');
  const todos = [
    { taskId: 'tid_a', taskContent: '真无日期', todoTime: 0, complete: false, delete: false },
    { taskId: 'tid_b', taskContent: 'todoTime=0但有dayStart', todoTime: 0, dayStart: start, complete: false, delete: false },
  ];
  const { sandbox } = makeSandbox(todos);
  const client = makeClient(sandbox);
  const r = await client.getTodos({ noDate: true });
  assert.deepEqual(r.map((t) => t.taskId), ['tid_a']);
});

test('createTodo: 返回 taskId + date 本地时区 + reminderTime 合成', async () => {
  const today = dateStr(0);
  const { sandbox, store } = makeSandbox([]);
  const client = makeClient(sandbox);
  const r = await client.createTodo({ title: '买菜', date: today, reminderTime: '09:00', categoryId: 5, difficulty: 2 });

  assert.equal(r.ok, true);
  assert.ok(r.taskId, '应返回 taskId');
  assert.equal(r.todoTime, localTs(today, '00:00'), 'date 应解析为本地零点');
  assert.equal(r.reminderTime, localTs(today, '09:00'), 'reminderTime 应与 date 合成');
  assert.equal(r.categoryId, 5);
  assert.equal(r.taskContent, '买菜');
  assert.equal(store.state.todo.todoList.length, 1, 'store 中应有新建任务');
  assert.equal(store.state.todo.todoList[0].snowAssess, 2, 'difficulty → snowAssess');
});

test('createTodo: 注入 userId 优先用 auth.user.userId（缺省回落 id）', async () => {
  // auth.user 只有 userId → 用 userId
  const s1 = makeSandbox([], [], { userId: 9999 });
  const c1 = makeClient(s1.sandbox);
  const r1 = await c1.createTodo({ title: 'A' });
  assert.equal(r1.params.userId, 9999, '应使用 auth.user.userId');

  // auth.user 只有 id（老结构）→ 回落 id
  const s2 = makeSandbox([], [], { id: 12345 });
  const c2 = makeClient(s2.sandbox);
  const r2 = await c2.createTodo({ title: 'B' });
  assert.equal(r2.params.userId, 12345, '缺 userId 时回落 auth.user.id');
});

test('createTodo: sublist 别名映射 todoSublist 并落库 standbyStr2', async () => {
  const { sandbox, store } = makeSandbox([]);
  const client = makeClient(sandbox);
  const sub = '- [ ]买牛奶[end] - [x]拖地';
  const r = await client.createTodo({ title: '清单任务', sublist: sub, categoryId: 1001 });
  assert.equal(r.ok, true);
  assert.equal(r.params.todoSublist, sub, 'sublist 应映射到 todoSublist');
  assert.equal(store.state.todo.todoList[0].standbyStr2, sub, '应写入 standbyStr2');
  assert.equal(store.state.todo.todoList[0].standbyInt1, 1001, '分类应写入 standbyInt1');
});

test('createTodo: 只传 reminderTime（无 date）用今天', async () => {
  const today = dateStr(0);
  const { sandbox } = makeSandbox([]);
  const client = makeClient(sandbox);
  const r = await client.createTodo({ title: '今天提醒', reminderTime: '08:30' });
  assert.equal(r.ok, true);
  assert.equal(r.reminderTime, localTs(today, '08:30'));
});

test('deleteTodo: 数字 id 可删', async () => {
  const todos = [{ id: 33941385, taskId: 'tid_real_1', taskContent: '任务A', complete: false, delete: false }];
  const { sandbox, store } = makeSandbox(todos);
  const client = makeClient(sandbox);
  const r = await client.deleteTodo(33941385);
  assert.equal(r.ok, true);
  assert.equal(r.taskContent, '任务A');
  assert.equal(store.state.todo.todoList.length, 0, '应已从 store 移除');
});

test('deleteTodo: taskId 字符串可删', async () => {
  const todos = [{ id: 1, taskId: 'tid_real_2', taskContent: '任务B', complete: false, delete: false }];
  const { sandbox, store } = makeSandbox(todos);
  const client = makeClient(sandbox);
  const r = await client.deleteTodo('tid_real_2');
  assert.equal(r.ok, true);
  assert.equal(store.state.todo.todoList.length, 0);
});

test('deleteTodo: 含引号的 id 不注入不崩', async () => {
  const todos = [{ id: 1, taskId: 'tid_real_3', taskContent: '任务C' }];
  const { sandbox } = makeSandbox(todos);
  const client = makeClient(sandbox);
  const evil = 'x";evil();//';
  const r = await client.deleteTodo(evil);
  assert.ok(r.__error__, '应返回 not found 而非执行注入');
  assert.ok(String(r.__error__).includes('todo not found'));
});

test('deleteTodo: 找不到返回 __error__', async () => {
  const { sandbox } = makeSandbox([]);
  const client = makeClient(sandbox);
  const r = await client.deleteTodo('tid_not_exist');
  assert.ok(r.__error__);
});

test('getTodo/getTodos: standbyStr2 解析为 subtasks 数组（保留原始串）', async () => {
  const todos = [
    { taskId: 'tid_s1', taskContent: '带子清单', complete: false, delete: false, standbyStr2: '- [ ]买牛奶[end] - [x]拖地[end] - [ ]看书' },
    { taskId: 'tid_s2', taskContent: '无子清单', complete: false, delete: false, standbyStr2: null },
  ];
  const { sandbox } = makeSandbox(todos);
  const client = makeClient(sandbox);

  // getTodo：解析 + 保留原始串
  const r1 = await client.getTodo('tid_s1');
  assert.equal(r1.found, true);
  assert.deepEqual(r1.todo.subtasks, [
    { content: '买牛奶', done: false },
    { content: '拖地', done: true },
    { content: '看书', done: false },
  ]);
  assert.equal(r1.todo.standbyStr2, '- [ ]买牛奶[end] - [x]拖地[end] - [ ]看书', '应保留原始 standbyStr2');
  const r2 = await client.getTodo('tid_s2');
  assert.deepEqual(r2.todo.subtasks, [], '无子清单应为空数组');

  // getTodos：每个任务都带 subtasks
  const all = await client.getTodos({});
  const s1 = all.find((t) => t.taskId === 'tid_s1');
  const s2 = all.find((t) => t.taskId === 'tid_s2');
  assert.equal(s1.subtasks.length, 3);
  assert.equal(s1.subtasks[1].done, true);
  assert.deepEqual(s2.subtasks, []);
});

test('getTodo: 按 taskId 和数字 id', async () => {
  const todos = [{ id: 42, taskId: 'tid_g1', taskContent: '查询目标' }];
  const { sandbox } = makeSandbox(todos);
  const client = makeClient(sandbox);
  const r1 = await client.getTodo('tid_g1');
  assert.equal(r1.found, true);
  assert.equal(r1.todo.taskContent, '查询目标');
  const r2 = await client.getTodo(42);
  assert.equal(r2.found, true);
});

test('updateTodo: 标记完成 + 改备注（映射到 store 字段）', async () => {
  const todos = [{ id: 1, taskId: 'tid_u1', taskContent: '旧标题', taskDescribe: '', complete: false, delete: false }];
  const { sandbox, store } = makeSandbox(todos);
  const client = makeClient(sandbox);
  const r = await client.updateTodo('tid_u1', { complete: true, content: '新备注' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, { taskId: 'tid_u1', complete: true, taskDescribe: '新备注' });
  assert.equal(store.state.todo.todoList[0].complete, true);
  assert.equal(store.state.todo.todoList[0].taskDescribe, '新备注');
});

test('updateTodo: 找不到返回 __error__', async () => {
  const { sandbox } = makeSandbox([]);
  const client = makeClient(sandbox);
  const r = await client.updateTodo('tid_zzz', { complete: true });
  assert.ok(r.__error__);
});

test('getCategories: store 未就绪返回 __error__', async () => {
  // document 存在但没有 __vue__ → VUEX_EXPR 返回 null
  const sandbox = { document: { querySelector: () => null } };
  const client = makeClient(sandbox);
  const r = await client.getCategories();
  assert.ok(r.__error__ === 'no store');
});
