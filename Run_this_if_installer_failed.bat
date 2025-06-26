@echo off
:: BatchGotAdmin (Run as Admin) Code Starts
:: Jump to UAC check if not already elevated

:-------------------------------------
:: Check for admin rights
net session >nul 2>&1
if %errorLevel% == 0 (
    call :MainScript
) else (
    echo Requesting administrative privileges...
    goto UACPrompt
)
exit /b
:: End of Admin check

:UACPrompt
echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\getadmin.vbs"
echo UAC.ShellExecute "%~s0", "", "", "runas", 1 >> "%temp%\getadmin.vbs"
"%temp%\getadmin.vbs"
exit /b

:: Proceed with actual script
:MainScript
:: Clean up temp file if it exists
if exist "%temp%\getadmin.vbs" del "%temp%\getadmin.vbs" >nul 2>&1

:: Main Script Content Below
color 2
title REMATCH Installer by Barry's Game Store
echo REMATCH Patcher by Barry's Game Store & echo.

echo.
echo === Step 1: Enabling Developer Mode ===
call :developeron

echo.
echo === Step 2: Installing Game ===
call :gameinstall

echo.
echo === Step 3: Disabling Developer Mode ===
call :developeroff

echo.
echo === Step 4: Exiting ===
timeout /t 3 >nul
exit

:: Functions Below

:developeron
reg add "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /t REG_DWORD /f /v "AllowDevelopmentWithoutDevLicense" /d "1"
goto :eof

:developeroff
reg add "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /t REG_DWORD /f /v "AllowDevelopmentWithoutDevLicense" /d "0"
goto :eof

:gameinstall
set file_check="%~dp0AppxSignature.p7x"
set file_check_new="AppxSignature.tmp"

IF EXIST %file_check% REN %file_check% %file_check_new%

"%~dp0EOS_Installer\EasyAntiCheat_EOS\EasyAntiCheat_EOS_Setup.exe" install 962c6b6db976409683df28e36e1e82de
"%~dp0wdapp" register "%~dp0appxmanifest.xml"
goto :eof