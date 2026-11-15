@echo off
setlocal
cd /d "%~dp0"
set "TIKTOKER_NODE=%~dp0.runtime\node.exe"
if exist "%TIKTOKER_NODE%" goto validate
set "TIKTOKER_NODE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined TIKTOKER_NODE set "TIKTOKER_NODE=%%N"
if not defined TIKTOKER_NODE goto missing
:validate
"%TIKTOKER_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto missing
if /i "%~1"=="--check" (
  "%TIKTOKER_NODE%" --version
  exit /b 0
)
echo Open http://127.0.0.1:4317 in your browser.
"%TIKTOKER_NODE%" src\server.mjs
set "TIKTOKER_EXIT=%ERRORLEVEL%"
pause
exit /b %TIKTOKER_EXIT%
:missing
echo Node.js 22+ was not found in .runtime or PATH.
echo Restore .runtime\node.exe or install Node.js 22+.
if /i not "%~1"=="--check" pause
exit /b 1
