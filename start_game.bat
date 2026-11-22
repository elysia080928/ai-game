@echo off
setlocal
cd /d "%~dp0"

set "PYTHON=py -3.12"
py -3.12 --version >nul 2>&1
if not errorlevel 1 goto python_ready

set "PYTHON=python"
python -c "import sys; raise SystemExit(sys.version_info < (3, 12))" >nul 2>&1
if errorlevel 1 goto missing_python

:python_ready
if not exist ".venv\Scripts\python.exe" (
  %PYTHON% -m venv .venv
  if errorlevel 1 goto setup_failed
)

".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto setup_failed

for /f %%p in ('powershell -NoProfile -Command "$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0); $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop(); Write-Output $port"') do set "GAME_PORT=%%p"
if not defined GAME_PORT goto port_busy

start "Game server" /min "%CD%\.venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port %GAME_PORT%
powershell -NoProfile -Command "$port = %GAME_PORT%; $deadline = (Get-Date).AddSeconds(30); while ((Get-Date) -lt $deadline) { try { $response = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $port + '/') -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 250 }; exit 1"
if errorlevel 1 goto server_failed

start "" "http://127.0.0.1:%GAME_PORT%/"
echo The game is running at http://127.0.0.1:%GAME_PORT%/. Keep the minimized Game server window open.
exit /b 0

:missing_python
echo Python 3.12 or newer is required. Install Python, then run this file again.
pause
exit /b 1

:port_busy
echo Could not find a free local port for the game server.
pause
exit /b 1

:server_failed
echo The game server did not start. Check the minimized Game server window.
pause
exit /b 1

:setup_failed
echo Python setup failed. Check your internet connection and Python installation.
pause
exit /b 1
