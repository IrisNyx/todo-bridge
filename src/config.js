/**
 * config.js — Todo Bridge 配置
 */

const path = require('path');

const CONFIG = {
  // Todo清单.exe 路径 — 用环境变量 TODO_LIST_EXE 覆盖（无需改代码）；默认是占位符
  exePath: process.env.TODO_LIST_EXE || 'C:/path/to/Todo清单.exe',

  // CDP 调试端口
  cdpPort: 9222,

  // 连接超时 (ms) — CDP.List / connect 都用它
  timeout: 15000,

  // HTTP 模式端口与 MCP 路径（MCP Streamable HTTP）
  httpPort: 3100,
  httpPath: '/mcp',
};

module.exports = { CONFIG };
