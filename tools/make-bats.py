# -*- coding: utf-8 -*-
"""GitHub 公開用の .bat を cp932 で書き出し、cmd が誤解する危険なバイトが無いか検査する。

日本語Windowsのcmdは、バッチファイルを cp932 として読む。
2バイト文字の「2バイト目」が & | > < ^ % と同じ値だと行が壊れるので、
書き出す前に全文を走査して確認する（03_web/tools/make-bats.py と同じ方式）。

このため、次の文字は .bat の中では使えない。言い換えて避けること。
  録 タ 真 …… 2バイト目が ^    ポ …… 2バイト目が |
検査に引っかかると、その文字と前後の文章を表示して止まる。

  python tools\\make-bats.py
"""
import os

OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DANGER = {0x26: "&", 0x7C: "|", 0x3E: ">", 0x3C: "<", 0x5E: "^", 0x25: "%"}

HEADER = """@echo off
rem ---------------------------------------------------------------
rem  このファイルは Shift-JIS(cp932) で保存してあります。
rem  作り直すときは python tools\\make-bats.py を実行してください。
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
for /f "delims=" %%D in ('dir /b /s /a:d "%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\node-v*-win-x64" 2^>nul') do set "PATH=%PATH%;%%D"
where node >nul 2>&1
if %errorlevel%==0 goto NODE_OK
echo.
echo [エラー] Node.js が見つかりません。
echo         パソコンを再起動してから、もう一度お試しください。
echo.
pause
exit /b 1
:NODE_OK
"""

SETUP = HEADER + """
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
echo  これで、2〜3分後に候補者ページが公開されます。
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
"""

PUBLISH = HEADER + """
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
echo  送りました。2〜3分後に、上に出ているURLが新しい内容になります。
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
"""

FILES = {
    "1-初回設定.bat": SETUP,
    "2-公開.bat": PUBLISH,
}


def check(data):
    """cp932 の2バイト目に危険なバイトが無いか調べる"""
    i = 0
    bad = []
    while i < len(data):
        b = data[i]
        if (0x81 <= b <= 0x9F) or (0xE0 <= b <= 0xFC):
            second = data[i + 1]
            if second in DANGER:
                ctx = data[max(0, i - 20):i + 6].decode("cp932", errors="replace")
                ctx = ctx.replace("\r", "").replace("\n", "/")
                bad.append((data[i:i + 2].decode("cp932", errors="replace"), DANGER[second], ctx))
            i += 2
        else:
            i += 1
    return bad


def main():
    ng = False
    for name, text in FILES.items():
        data = text.replace("\r\n", "\n").replace("\n", "\r\n").encode("cp932")
        bad = check(data)
        if bad:
            ng = True
            print("[NG] " + name)
            for ch, sym, ctx in bad:
                print("      文字「%s」の2バイト目が %s と同じです … %s" % (ch, sym, ctx))
            continue
        path = os.path.join(OUT, name)
        with open(path, "wb") as f:
            f.write(data)
        print("[OK] %s  %d bytes" % (name, len(data)))
    if ng:
        print("\n上の文字を別の言い方に変えてから、もう一度実行してください。")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
