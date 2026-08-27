@echo off
:: 启动 Todo Bridge MCP Server (HTTP 模式, 端口 3100)
:: 提供双端点：
::   MCP Streamable HTTP:  POST /mcp   (可注册进 gateway mcp_servers / 标准 MCP 客户端)
::   REST:                 GET  /health | GET /tools | POST /call/:toolName
cd /d "%~dp0"
echo ========================================
echo  Todo Bridge MCP Server - HTTP Mode
echo  地址: http://127.0.0.1:3100
echo  MCP  : POST /mcp
echo  健康 : http://127.0.0.1:3100/health
echo  工具 : http://127.0.0.1:3100/tools
echo  调用 : POST /call/todo.getTodos  等
echo ========================================
node src/mcp-server.js --http --port 3100
