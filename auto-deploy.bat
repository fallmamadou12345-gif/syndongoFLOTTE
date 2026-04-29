@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================
REM SyNdongo - Deploiement AUTOMATIQUE en arriere-plan
REM ============================================
REM Surveille les modifications de fichiers et pousse
REM automatiquement sur GitHub (donc sur Railway) toutes
REM les 5 minutes s'il y a des changements.
REM
REM Usage : double-clic, laisser tourner en arriere-plan.
REM Pour arreter : fermer la fenetre.
REM ============================================

cd /d "%~dp0"

echo.
echo  ============================================
echo   SyNdongo - AUTO-DEPLOIEMENT ACTIF
echo  ============================================
echo  Verifie les modifications toutes les 5 min
echo  et pousse automatiquement vers Railway.
echo.
echo  Pour arreter : fermez cette fenetre.
echo  ============================================
echo.

:loop
REM --- Verifier git ---
git diff-index --quiet HEAD -- 2>nul
set "has_unstaged=!errorlevel!"

git status --porcelain | findstr "." >nul
set "has_changes=!errorlevel!"

if !has_changes!==0 (
    REM Il y a des changements
    for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value 2^>nul') do set "dt=%%a"
    set "stamp=!dt:~0,4!-!dt:~4,2!-!dt:~6,2! !dt:~8,2!:!dt:~10,2!"

    echo [!stamp!] Changements detectes - Push en cours...
    git add -A
    git commit -m "Auto-update !stamp!" >nul 2>&1
    git push origin main 2>&1 | findstr /v "^$"
    if errorlevel 1 (
        echo [!stamp!] [ERREUR] Push echoue. Nouvelle tentative dans 5 min.
    ) else (
        echo [!stamp!] [OK] Deploye vers Railway.
    )
    echo.
) else (
    REM Verifier s'il y a des commits locaux a pousser
    for /f %%i in ('git rev-list --count "@{u}..HEAD" 2^>nul') do set "ahead=%%i"
    if defined ahead (
        if !ahead! GTR 0 (
            for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value 2^>nul') do set "dt=%%a"
            set "stamp=!dt:~0,4!-!dt:~4,2!-!dt:~6,2! !dt:~8,2!:!dt:~10,2!"
            echo [!stamp!] !ahead! commit(s) en attente - Push...
            git push origin main 2>&1 | findstr /v "^$"
            echo.
        )
    )
)

REM --- Attendre 5 minutes ---
timeout /t 300 /nobreak >nul
goto loop
