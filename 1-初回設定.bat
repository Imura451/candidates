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
echo  初回設定  このフォルダを GitHub につなぎます
echo ------------------------------------------------------------
echo  先に GitHub で Public の保存先を作っておいてください。
echo  （中は空のまま。README などは追加しない）
echo  例: https://github.com/Imura451/candidates
echo ============================================================
echo.
set "REPO_URL="
set /p REPO_URL="保存先のURLを貼り付けて Enter: "
if "%REPO_URL%"=="" goto NO_URL

rem git の名前とメールが未設定なら入れる（変更の履歴に残す名前）
rem 未設定だと git config は終了コード1を返すので、それで判定する
git config --global user.name >nul 2>&1
if %errorlevel%==0 goto NAME_OK
git config --global user.name "Minoru Imura"
git config --global user.email "gaikokujin18@gmail.com"
:NAME_OK

if exist ".git" goto INIT_OK
git init -b main >nul 2>&1
:INIT_OK

git remote remove origin >nul 2>&1
git remote add origin "%REPO_URL%"

echo.
echo  最初のビルドをしています...
call node build.js
if not %errorlevel%==0 goto BUILD_NG

git add -A
git commit -m "first commit" >nul 2>&1
git branch -M main

echo.
echo  GitHub に送っています。ブラウザが開いたら GitHub にログインしてください。
echo  （最初の1回だけです）
echo.
git push -u origin main
if not %errorlevel%==0 goto PUSH_NG

echo.
echo ============================================================
echo  つながりました。あと1つだけ GitHub の画面で設定します。
echo ------------------------------------------------------------
echo   1. ブラウザで %REPO_URL% を開く
echo   2. 上のほうにある Settings を開く
echo   3. 左メニューの Pages を開く
echo   4. Build and deployment の Source を GitHub Actions にする
echo.
echo  これで、2～3分後に候補者ページが公開されます。
echo  企業に渡すURLは、上に出ている「企業に渡すURL」です。
echo  次回からは 2-公開.bat だけで更新できます。
echo ============================================================
echo.
pause
exit /b 0

:NO_URL
echo.
echo [中止] URLが入力されませんでした。
pause
exit /b 1

:BUILD_NG
echo.
echo [エラー] ビルドに失敗しました。上のメッセージを確認してください。
pause
exit /b 1

:PUSH_NG
echo.
echo [エラー] GitHub に送れませんでした。
echo   ・URLが正しいか（https://github.com/ユーザー名/保存先の名前）
echo   ・保存先が空か（README を付けて作った場合は作り直してください）
echo   ・ログインを求められた画面で許可したか
echo  を確認して、もう一度お試しください。
pause
exit /b 1
