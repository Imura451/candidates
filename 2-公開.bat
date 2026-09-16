@echo off
rem ---------------------------------------------------------------
rem  このファイルは Shift-JIS(cp932) で保存してあります。
rem  作り直すときは python tools\make-bats.py を実行してください。
rem ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

where git >nul 2>&1
if %errorlevel%==0 goto GIT_OK
echo.
echo [エラー] Git が見つかりません。
echo         https://git-scm.com/download/win から入れて、パソコンを再起動してください。
echo.
pause
exit /b 1
:GIT_OK

where node >nul 2>&1
if %errorlevel%==0 goto NODE_OK
for /f "delims=" %%D in ('dir /b /s /a:d "%LOCALAPPDATA%\Microsoft\WinGet\Packages\node-v*-win-x64" 2^>nul') do set "PATH=%PATH%;%%D"
where node >nul 2>&1
if %errorlevel%==0 goto NODE_OK
echo.
echo [エラー] Node.js が見つかりません。
echo         パソコンを再起動してから、もう一度お試しください。
echo.
pause
exit /b 1
:NODE_OK

echo ============================================================
echo  候補者ページをビルドして GitHub に送ります
echo ============================================================
echo.
call node build.js
if not %errorlevel%==0 goto BUILD_NG

echo.
git add -A
git commit -m "update candidates" >nul 2>&1
git pull --rebase origin main >nul 2>&1
git push origin main
if not %errorlevel%==0 goto PUSH_NG

echo.
echo ------------------------------------------------------------
echo  送りました。2～3分後に、上に出ているURLが新しい内容になります。
echo  「確認してください」が出ている候補者は、顔画像や動画を足してから
echo  もう一度このファイルを実行してください。
echo ------------------------------------------------------------
echo.
pause
exit /b 0

:BUILD_NG
echo.
echo [エラー] ビルドに失敗しました。上のメッセージを確認してください。
echo         JSON の書き間違い（カンマの抜け、id の重なり）が多いです。
pause
exit /b 1

:PUSH_NG
echo.
echo [エラー] GitHub に送れませんでした。
echo         ネット接続を確認して、もう一度お試しください。
echo         初回設定がまだなら、先に 1-初回設定.bat を実行してください。
pause
exit /b 1
