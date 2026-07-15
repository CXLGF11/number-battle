@echo off
chcp 65001 >nul 2>&1
title 数字猜猜猜 - 外网联机服务器
echo.
echo  ═════════════════════════════════════════════
echo           🎲 数字猜猜猜 - 外网联机模式
echo  ═════════════════════════════════════════════
echo.

:: ===== 检查 cloudflared =====
where cloudflared >nul 2>&1
if %errorlevel% neq 0 (
    if exist "%~dp0cloudflared.exe" (
        set "CF_PATH=%~dp0cloudflared.exe"
    ) else (
        echo  ⚠️  未检测到 cloudflared，正在尝试安装...
        echo.
        winget install Cloudflare.cloudflared --accept-package-agreements --accept-source-agreements 2>nul
        if %errorlevel% neq 0 (
            echo.
            echo  ❌ 自动安装失败，请手动安装：
            echo     1. 打开 https://github.com/cloudflare/cloudflared/releases/latest
            echo     2. 下载 cloudflared-windows-amd64.exe
            echo     3. 放到当前目录并重命名为 cloudflared.exe
            echo.
            pause
            exit /b 1
        )
        echo  ✅ 安装成功！
        :: 刷新 PATH
        set "PATH=%PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Links"
    )
)

:: ===== 启动游戏服务器 =====
echo  [1/2] 启动游戏服务器...
start /b node "%~dp0server.js" >nul 2>&1
timeout /t 3 /nobreak >nul

:: 检查服务器
powershell -command "(Invoke-WebRequest -Uri http://localhost:7788/health -UseBasicParsing -TimeoutSec 5).Content" 2>nul | findstr "ok" >nul
if %errorlevel% neq 0 (
    echo  ❌ 服务器启动失败！请确认：
    echo     - 已安装 Node.js（node --version 检查）
    echo     - 已运行 npm install
    echo.
    pause
    exit /b 1
)
echo  ✅ 游戏服务器已启动（端口 7788）
echo.

:: ===== 启动隧道 =====
echo  [2/2] 启动 Cloudflare Tunnel...
echo.
echo  ⏳ 正在连接，请稍候（首次约 5-10 秒）...
echo  ────────────────────────────────────────────
echo.

:: 启动 cloudflared
if defined CF_PATH (
    "%CF_PATH%" tunnel --url http://localhost:7788
) else (
    cloudflared tunnel --url http://localhost:7788
)
