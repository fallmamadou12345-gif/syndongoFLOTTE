@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo.
echo  ════════════════════════════════════════════════
echo   IMPORT ADAMA — DU 30 MARS AU 25 AVRIL 2026
echo  ════════════════════════════════════════════════
echo.
echo   Source : DU 30 AU 25 AVRIL - Feuille 1.pdf
echo   Total facture attendu  : 9 927 500 F
echo   Total encaisse attendu : 9 673 000 F
echo   54 vehicules
echo.
echo  ════════════════════════════════════════════════
echo.

REM --- Verifier Node ---
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Node.js non trouve. Installez-le sur https://nodejs.org
    pause
    exit /b 1
)

echo  Choisissez le mode :
echo.
echo    1 - DRY-RUN (test, aucune ecriture) — RECOMMANDE D'ABORD
echo    2 - LOCAL  (http://localhost:8000)
echo    3 - RAILWAY (production en ligne)
echo    4 - URL personnalisee
echo.
set /p mode="Votre choix [1-4] : "

if "%mode%"=="1" (
    echo.
    echo Lancement en mode DRY-RUN...
    set /p url="URL pour le test (Entree = http://localhost:8000) : "
    if "!url!"=="" set "url=http://localhost:8000"
    set /p pwd="Mot de passe : "
    node import_adama_avril.js --url !url! --password !pwd! --dry-run
    goto :end
)

if "%mode%"=="2" (
    set "url=http://localhost:8000"
    goto :ask_pwd
)

if "%mode%"=="3" (
    set /p url="URL Railway (ex: https://syndongoflotte.up.railway.app) : "
    if "!url!"=="" (
        echo [ERREUR] URL requise
        pause
        exit /b 1
    )
    goto :ask_pwd
)

if "%mode%"=="4" (
    set /p url="URL : "
    goto :ask_pwd
)

echo Choix invalide.
pause
exit /b 1

:ask_pwd
echo.
set /p pwd="Mot de passe (Manager ou ADAMA) : "
echo.
echo  ⚠️  ATTENTION : ceci va ecrire les donnees en PRODUCTION sur :
echo      !url!
echo.
set /p confirm="Tapez OUI pour confirmer : "
if not "!confirm!"=="OUI" (
    echo Annule.
    pause
    exit /b 0
)

echo.
node import_adama_avril.js --url !url! --password !pwd!

:end
echo.
pause
