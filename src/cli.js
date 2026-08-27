#!/usr/bin/env node
/**
 * cli.js — Todo Bridge 命令行入口
 *
 * 用法:
 *   node src/cli.js doctor              诊断环境
 *   node src/cli.js ping                测试连接 + Store 概览
 *   node src/cli.js diagnose            Store 结构诊断
 *   node src/cli.js categories          列出分类
 *   node src/cli.js list [--date YYYY-MM-DD] [--no-date] [--from ...] [--to ...] [--active] [--categoryId N] [--limit N]
 *   node src/cli.js get <id|taskId>     查询单条任务
 *   node src/cli.js add "标题" [选项]   添加任务
 *   node src/cli.js update <id> [选项]  修改任务/标记完成
 *   node src/cli.js delete <id|taskId>  删除任务
 *   node src/cli.js sync                触发同步
 *   node src/cli.js mcp [--http] [--port N]  启动 MCP Server
 */

const fs = require('fs');
const net = require('net');
const { execSync } = require('child_process');
const TodoClient = require('./todo-client');
const { CONFIG } = require('./config');

function usage() {
  console.log(
    'Todo Bridge CLI\n' +
    '  node src/cli.js doctor                诊断环境\n' +
    '  node src/cli.js ping                  测试连接 + Store 概览\n' +
    '  node src/cli.js diagnose              Store 结构诊断\n' +
    '  node src/cli.js categories            列出分类\n' +
    '  node src/cli.js list [--date YYYY-MM-DD] [--no-date] [--from ISO] [--to ISO] [--active] [--categoryId N] [--limit N]\n' +
    '  node src/cli.js today [--active] [--categoryId N] [--limit N]   今天所有任务\n' +
    '  node src/cli.js get <id|taskId>       查询单条任务\n' +
    '  node src/cli.js add "标题" [--difficulty N] [--date YYYY-MM-DD] [--reminder HH:MM] [--categoryId N] [--content ...] [--sublist "- [ ]子任务[end] - [x]已完成"]\n' +
    '  node src/cli.js update <id> [--complete true|false] [--content ...] [--date ...] [--reminder HH:MM] [--categoryId N] [--difficulty N]\n' +
    '  node src/cli.js delete <id|taskId>    删除任务\n' +
    '  node src/cli.js sync                  触发同步\n' +
    '  node src/cli.js mcp [--http] [--port N]   启动 MCP Server (默认 STDIO)'
  );
}

async function doctor() {
  console.log('[Doctor] 诊断 Todo Bridge 环境...\n');

  // exe path
  console.log('[1] Todo清单.exe');
  console.log('    路径: ' + CONFIG.exePath);
  if (fs.existsSync(CONFIG.exePath)) {
    console.log('    状态: ✅ 文件存在');
  } else {
    console.log('    状态: ❌ 文件不存在，请修改 src/config.js');
  }

  // CDP port
  console.log('\n[2] CDP 端口 ' + CONFIG.cdpPort);
  const portOpen = await new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(CONFIG.cdpPort, '127.0.0.1');
  });
  if (portOpen) {
    console.log('    状态: ✅ 端口已开放（App 已在调试模式运行）');
  } else {
    console.log('    状态: ⚠️ 端口未开放');
    console.log('    提示: 以 --remote-debugging-port=' + CONFIG.cdpPort + ' 启动 Todo清单.exe');
  }

  // running process
  console.log('\n[3] Todo清单 进程');
  try {
    const out = execSync('tasklist /fi "IMAGENAME eq Todo清单.exe" /nh', { encoding: 'utf8', timeout: 3000 });
    if (out.includes('Todo清单.exe')) {
      console.log('    状态: ✅ 运行中');
    } else {
      console.log('    状态: ⚠️ 未运行');
    }
  } catch (e) {
    console.log('    状态: ⚠️ 无法检测');
  }

  // Node.js
  console.log('\n[4] Node.js');
  console.log('    版本: ' + process.version);

  console.log('\n[Doctor] 完成');
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) { usage(); return; }

  if (cmd === 'doctor') {
    await doctor();
    return;
  }

  if (cmd === 'mcp') {
    const mcp = require('./mcp-server');
    const args = process.argv.slice(3);
    if (args.includes('--http')) {
      const pi = args.indexOf('--port');
      const port = pi !== -1 ? parseInt(args[pi + 1]) : CONFIG.httpPort;
      mcp.startHttpMode(port);
    } else {
      mcp.startStdioMode();
    }
    return;
  }

  // 以下命令需要 CDP
  const client = new TodoClient({ cdpPort: CONFIG.cdpPort, timeout: CONFIG.timeout });

  try {
    await client.connect();

    switch (cmd) {
      case 'ping': {
        const r = await client.ping();
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'diagnose': {
        const r = await client.getDiagnostics();
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'categories': {
        const r = await client.getCategories();
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'list': {
        const filter = {};
        const argv = process.argv.slice(3);
        for (let i = 0; i < argv.length; i++) {
          if (argv[i] === '--date' && argv[i + 1] !== undefined) { filter.date = argv[i + 1]; i++; }
          else if (argv[i] === '--from' && argv[i + 1] !== undefined) { filter.from = argv[i + 1]; i++; }
          else if (argv[i] === '--to' && argv[i + 1] !== undefined) { filter.to = argv[i + 1]; i++; }
          else if (argv[i] === '--reminder-date' && argv[i + 1] !== undefined) { filter.reminderDate = argv[i + 1]; i++; }
          else if (argv[i] === '--reminder-from' && argv[i + 1] !== undefined) { filter.reminderFrom = argv[i + 1]; i++; }
          else if (argv[i] === '--reminder-to' && argv[i + 1] !== undefined) { filter.reminderTo = argv[i + 1]; i++; }
          else if (argv[i] === '--no-date') { filter.noDate = true; }
          else if (argv[i] === '--active') { filter.active = true; }
          else if (argv[i] === '--include-deleted') { filter.includeDeleted = true; }
          else if (argv[i] === '--limit' && argv[i + 1] !== undefined) { filter.limit = parseInt(argv[i + 1]); i++; }
          else if (argv[i] === '--categoryId' && argv[i + 1] !== undefined) { filter.categoryId = parseInt(argv[i + 1]); i++; }
        }
        const r = await client.getTodos(filter);
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'today': {
        const filter = {};
        const argv = process.argv.slice(3);
        for (let i = 0; i < argv.length; i++) {
          if (argv[i] === '--active') { filter.active = true; }
          else if (argv[i] === '--include-deleted') { filter.includeDeleted = true; }
          else if (argv[i] === '--limit' && argv[i + 1] !== undefined) { filter.limit = parseInt(argv[i + 1]); i++; }
          else if (argv[i] === '--categoryId' && argv[i + 1] !== undefined) { filter.categoryId = parseInt(argv[i + 1]); i++; }
        }
        const r = await client.todayTodos(filter);
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'get': {
        const id = process.argv[3];
        if (!id) { console.log('用法: node src/cli.js get <id|taskId>'); break; }
        const r = await client.getTodo(id);
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'add': {
        const title = process.argv[3];
        if (!title) {
          console.log('用法: node src/cli.js add "任务标题" [--difficulty 2] [--date 2026-06-16] [--reminder 09:00] [--categoryId 0] [--content ...]');
          break;
        }
        const opts = { todoContent: title };
        const argv = process.argv.slice(4);
        for (let i = 0; i < argv.length; i++) {
          if (argv[i] === '--difficulty' && argv[i + 1] !== undefined) { opts.difficulty = parseInt(argv[i + 1]); i++; }
          else if (argv[i] === '--date' && argv[i + 1] !== undefined) { opts.date = argv[i + 1]; i++; }
          else if (argv[i] === '--reminder' && argv[i + 1] !== undefined) { opts.reminderTime = argv[i + 1]; i++; }
          else if (argv[i] === '--categoryId' && argv[i + 1] !== undefined) { opts.categoryId = parseInt(argv[i + 1]); i++; }
          else if (argv[i] === '--content' && argv[i + 1] !== undefined) { opts.content = argv[i + 1]; i++; }
          else if (argv[i] === '--sublist' && argv[i + 1] !== undefined) { opts.sublist = argv[i + 1]; i++; }
        }
        const r = await client.createTodo(opts);
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'update': {
        const id = process.argv[3];
        if (!id) {
          console.log('用法: node src/cli.js update <id|taskId> [--complete true|false] [--content ...] [--date ...] [--reminder HH:MM] [--categoryId N] [--difficulty N]');
          break;
        }
        const patch = {};
        const argv = process.argv.slice(4);
        for (let i = 0; i < argv.length; i++) {
          if (argv[i] === '--complete' && argv[i + 1] !== undefined) { patch.complete = argv[i + 1] === 'true' || argv[i + 1] === '1'; i++; }
          else if (argv[i] === '--content' && argv[i + 1] !== undefined) { patch.content = argv[i + 1]; i++; }
          else if (argv[i] === '--date' && argv[i + 1] !== undefined) { patch.date = argv[i + 1]; i++; }
          else if (argv[i] === '--reminder' && argv[i + 1] !== undefined) { patch.reminderTime = argv[i + 1]; i++; }
          else if (argv[i] === '--categoryId' && argv[i + 1] !== undefined) { patch.categoryId = parseInt(argv[i + 1]); i++; }
          else if (argv[i] === '--difficulty' && argv[i + 1] !== undefined) { patch.difficulty = parseInt(argv[i + 1]); i++; }
        }
        const r = await client.updateTodo(id, patch);
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'delete': {
        const todoId = process.argv[3];
        if (!todoId) { console.log('用法: node src/cli.js delete <id|taskId>'); break; }
        const r = await client.deleteTodo(todoId);
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'sync': {
        const r = await client.syncNow();
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      default:
        console.log('未知命令: ' + cmd);
        usage();
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('错误: ' + err.message);
  process.exit(1);
});
