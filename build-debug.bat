@echo off
setlocal
cd /d "%~dp0"

echo === Pi Desktop: DEBUG build ===

if not exist node_modules (
  echo [1/4] Installing dependencies...
  call npm install || goto :err
) else (
  echo [1/4] Dependencies present, skipping install.
)

echo [2/4] Building TypeScript packages, host and UI...
call npm run build || goto :err

echo [3/4] Checking for Bun and building pi-host sidecar executable...
where bun >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    echo       Found existing Bun install not yet on PATH for this session.
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
  ) else (
    echo       Bun is required to compile the pi-host sidecar.
    echo       Install Bun or run release.bat once to install it automatically.
    goto :err
  )
)
call npm run build:host-exe || goto :err

echo [4/4] Building Tauri shell (debug profile, red icon)...
cd apps\shell\src-tauri
set "TAURI_CONFIG={"bundle":{"icon":["icons/32x32-debug.png","icons/128x128-debug.png","icons/icon-debug.png","icons/icon-debug.ico"]}}"
cargo build || goto :err
set "TAURI_CONFIG="
cd /d "%~dp0"

echo.
echo DONE. Debug binary: apps\shell\src-tauri\target\debug\pi-desktop-shell.exe
echo Reminder: the debug shell loads http://localhost:5173 - start "npm run dev:ui" before launching it.
exit /b 0

:err
echo.
echo BUILD FAILED (see errors above).
pause
exit /b 1
