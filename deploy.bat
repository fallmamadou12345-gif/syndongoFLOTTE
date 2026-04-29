@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo  ============================================
echo   SyNdongo - Deploiement automatique Railway
echo  ============================================
echo.

cd /d "%~dp0"

REM --- Verifier git ---
git --version >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Git n'est pas installe. Installez-le sur https://git-scm.com
    pause
    exit /b 1
)

REM --- Verifier qu'on est dans un repo git ---
if not exist ".git" (
    echo [ERREUR] Ce dossier n'est pas un depot git.
    pause
    exit /b 1
)

echo [1/4] Verification des modifications...
git status --short
echo.

REM --- Si rien a commiter, on quitte ---
git diff-index --quiet HEAD --
if not errorlevel 1 (
    git status --porcelain | findstr "." >nul
    if errorlevel 1 (
        echo [INFO] Aucun changement a deployer. Push des commits en attente...
        goto :push
    )
)

REM --- Demander un message de commit ---
set "msg="
set /p msg="[2/4] Message de commit (Entree = auto): "
if "!msg!"=="" (
    for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value') do set "dt=%%a"
    set "msg=Update !dt:~0,4!-!dt:~4,2!-!dt:~6,2! !dt:~8,2!:!dt:~10,2!"
)

echo.
echo [3/4] Ajout et commit...
git add -A
git commit -m "!msg!"
if errorlevel 1 (
    echo [ATTENTION] Echec du commit. Continuer le push ?
    pause
)

:push
echo.
echo [4/4] Push vers GitHub (Railway redeploiera automatiquement)...
git push origin main
if errorlevel 1 (
    echo.
    echo [ERREUR] Push echoue. Verifiez votre connexion et vos identifiants Github.
    pause
    exit /b 1
)

echo.
echo  ============================================
echo   DEPLOIEMENT REUSSI
echo  ============================================
echo  Railway va redeployer automatiquement dans
echo  ~30 secondes a 2 minutes.
echo.
echo  Suivez le deploiement sur :
echo  https://railway.app/
echo  ============================================
echo.
pause
