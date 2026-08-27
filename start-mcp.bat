@echo off
:: 启动 Todo Bridge MCP Server (STDIO 模式)
cd /d "%~dp0"
node src/mcp-server.js
