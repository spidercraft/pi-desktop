@echo off
setlocal
cd /d "%~dp0"

echo === Pi Desktop: RELEASE build + MSI installer ===

if not exist node_modules (
  echo [1/5] Installing dependencies...
  call npm install || goto :err
) else (
  echo [1/5] Dependencies present, skipping install.
)

echo [2/5] Building TypeScript packages, host and UI...
call npm run build || goto :err

echo [3/5] Checking for Bun ^(compiles pi-host to a standalone binary^)...
where bun >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    echo       Found existing install not yet on PATH for this session.
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
  ) else (
    echo       Not found, installing Bun via the official installer ^(one-time^)...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" || goto :err
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
    where bun >nul 2>nul || (
      echo       Bun installed but still not found on PATH.
      echo       Open a new terminal ^(so the updated PATH takes effect^) and re-run release.bat.
      goto :err
    )
  )
) else (
  echo       Found.
)

echo [4/5] Rebuilding pi-host sidecar executable...
call npm run build:host-exe || goto :err

echo [5/5] Checking for Tauri CLI (cargo-tauri)...
where cargo-tauri >nul 2>nul
if errorlevel 1 (
  echo       Not found, installing tauri-cli via cargo ^(one-time, can take a while^)...
  cargo install tauri-cli --version "^2.0.0" --locked || goto :err
) else (
  echo       Found.
)

echo Building Tauri shell ^(release^) and bundling MSI installer...
cd apps\shell\src-tauri
cargo tauri build || goto :err
cd /d "%~dp0"

echo.
echo DONE.
echo Release binary : apps\shell\src-tauri\target\release\pi-desktop-shell.exe
echo MSI installer  : apps\shell\src-tauri\target\release\bundle\msi\*.msi
exit /b 0

:err
echo.
echo BUILD FAILED (see errors above).
pause
exit /b 1
