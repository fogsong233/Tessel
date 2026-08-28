@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\preview-installed-windows.ps1" %*
if errorlevel 1 (
    echo.
    echo Preview deployment failed. See the error above.
    pause
    exit /b 1
)
endlocal
