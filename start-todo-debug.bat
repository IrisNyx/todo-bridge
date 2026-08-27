@echo off
chcp 65001 >nul
title Todo清单 Debug 启动器

:: Todo清单.exe 路径：从环境变量 TODO_LIST_EXE 读取（发布版不含真实路径）
:: 设置示例：set TODO_LIST_EXE=D:\path\to\Todo清单.exe
set "EXE=%TODO_LIST_EXE%"
if "%EXE%"=="" (
  echo [错误] 未设置环境变量 TODO_LIST_EXE。
  echo        请先设置它指向你的 Todo清单.exe，例如：
  echo          set TODO_LIST_EXE=D:\path\to\Todo清单.exe
  echo        或临时设置：set TODO_LIST_EXE=你的路径 ^& start-todo-debug.bat
  pause
  exit /b 1
)
if not exist "%EXE%" (
  echo [错误] 找不到文件：%EXE%
  pause
  exit /b 1
)

echo [1/3] 正在关闭已有的 Todo清单 进程...
taskkill /f /im "Todo清单.exe" 2>nul
timeout /t 2 /nobreak >nul

echo [2/3] 以 CDP 模式启动 Todo清单...
start "TodoDebug" "%EXE%" --remote-debugging-port=9222 --remote-allow-origins=*

echo [3/3] 等待 CDP 端口就绪...
:waitloop
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":9222.*LISTENING" >nul
if %errorlevel% neq 0 goto waitloop

echo.
echo ============================================
echo   Todo清单 已以 Debug 模式成功启动!
echo   CDP 端口: 127.0.0.1:9222
echo   现在可以启动 MCP Server 了
echo ============================================
echo.
pause
