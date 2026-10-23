@echo off
setlocal
set "HERE=%~dp0"
set "NODE="
for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
  if exist "%%~fD\dependencies\node\bin\node.exe" set "NODE=%%~fD\dependencies\node\bin\node.exe"
)
if not defined NODE for %%N in (node.exe) do if not defined NODE set "NODE=%%~$PATH:N"
if not defined NODE (
  echo.
  echo [X] Node not found on this machine.
  echo     Drop this folder into a DSH conversation instead, and tell it:
  echo         "read 装我.md and install this"
  echo.
  pause
  exit /b 1
)
echo Using node: %NODE%
echo.
"%NODE%" "%HERE%install.mjs" %*
echo.
echo If it installed, restart DSH to take effect.
pause