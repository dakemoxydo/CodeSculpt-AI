@echo off
setlocal

cd /d "%~dp0"
set "PORT=5173"
set "URL=http://127.0.0.1:%PORT%/"

if not exist "output\playwright" mkdir "output\playwright"

echo Starting CodeSculptAi on %URL% ...
start "CodeSculptAi Vite" /b cmd /d /c "npm.cmd run dev -- --host 127.0.0.1 --port %PORT% > output\playwright\vite.log 2>&1"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ready = $false; for ($i = 0; $i -lt 30; $i++) { try { $response = Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -TimeoutSec 1; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 500 } }; if (-not $ready) { exit 1 }"

if errorlevel 1 (
  echo Could not start the local server. Check output\playwright\vite.log.
  exit /b 1
)

start "" "%URL%"
echo CodeSculptAi is running at %URL%
endlocal
