@echo off
rem ==========================================================
rem  One Click Pack - self diagnosing version
rem  Every step prints what it is doing, so a hang is visible.
rem  Keep this file ASCII only.
rem ==========================================================
setlocal
cd /d "%~dp0"

set "LOGFILE=%~dp0pack-log.txt"
echo ==== One Click Pack log ==== > "%LOGFILE%"
echo Date: %DATE% %TIME% >> "%LOGFILE%"

echo ==========================================================
echo    One Click Pack
echo ==========================================================
echo    Folder : %~dp0
echo    Log    : %LOGFILE%
echo.

rem ---- step 0: node ----
echo [0/5] Checking node...
node -v >> "%LOGFILE%" 2>&1
if errorlevel 1 (
    echo [ERROR] node not found. Install Node.js first.
    echo [ERROR] node not found >> "%LOGFILE%"
    goto :end
)
for /f "delims=" %%V in ('node -v 2^>nul') do echo       node %%V
echo [ok] node >> "%LOGFILE%"

rem ---- step 1: files ----
echo [1/5] Checking files...
if not exist "plugin.json" (
    echo [ERROR] plugin.json missing in this folder.
    echo [ERROR] no plugin.json >> "%LOGFILE%"
    goto :end
)
echo       plugin.json    OK
if not exist "scripts\pack.mjs" (
    echo [ERROR] scripts\pack.mjs missing.
    echo [ERROR] no pack.mjs >> "%LOGFILE%"
    goto :end
)
echo       pack.mjs       OK
if exist "node_modules\vite\bin\vite.js" (
    echo       vite           OK
) else (
    echo [ERROR] node_modules\vite missing. Run npm install here.
    echo [ERROR] no vite >> "%LOGFILE%"
    goto :end
)
echo [ok] files >> "%LOGFILE%"

rem ---- step 2: build ----
echo.
echo [2/5] Building... this prints vite output below
echo.
set "NODE_ENV=production"
node "node_modules\vite\bin\vite.js" build < nul
set "BUILD_RC=%errorlevel%"
echo.
if not "%BUILD_RC%"=="0" (
    echo [ERROR] build failed, exit code %BUILD_RC%
    echo [ERROR] build failed %BUILD_RC% >> "%LOGFILE%"
    goto :end
)
echo       Build          OK
echo [ok] build >> "%LOGFILE%"

rem ---- step 3: pack ----
echo.
echo [3/5] Packing...
node "scripts\pack.mjs" < nul
set "PACK_RC=%errorlevel%"
echo.
if not "%PACK_RC%"=="0" (
    echo [ERROR] pack failed, exit code %PACK_RC%
    echo [ERROR] pack failed %PACK_RC% >> "%LOGFILE%"
    goto :end
)
echo       Pack           OK
echo [ok] pack >> "%LOGFILE%"

rem ---- step 4: verify ----
echo.
echo [4/5] Checking the zip...
set "FOUND="
for %%F in ("siyuan-plugin-ai-chat-v*.zip") do set "FOUND=%%F"
if not defined FOUND (
    echo [ERROR] no zip was created.
    echo [ERROR] no zip >> "%LOGFILE%"
    goto :end
)
echo       Zip            %FOUND%
for %%A in ("%FOUND%") do echo       Size           %%~zA bytes
echo [ok] zip %FOUND% >> "%LOGFILE%"

echo.
echo [5/5] SUCCESS
echo ==========================================================
echo    Done. The zip is in this folder:
echo    %~dp0%FOUND%
echo ==========================================================
echo [ok] SUCCESS >> "%LOGFILE%"
goto :end

:end
echo.
echo Log written to: %LOGFILE%
echo.
pause
endlocal
