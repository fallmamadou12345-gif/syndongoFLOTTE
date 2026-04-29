@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================
REM SyNdongo - Sauvegarde automatique des donnees
REM ============================================
REM Sauvegarde syndongo_data.json + import_data_local.json
REM dans le dossier backups/ avec horodatage.
REM Conserve les 30 dernieres sauvegardes.
REM ============================================

cd /d "%~dp0"

REM --- Date/Heure formatees ---
for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value 2^>nul') do set "dt=%%a"
set "stamp=!dt:~0,4!-!dt:~4,2!-!dt:~6,2!_!dt:~8,2!h!dt:~10,2!"

REM --- Creer dossier backups ---
if not exist "backups" mkdir backups

echo.
echo [BACKUP %stamp%] Sauvegarde en cours...

REM --- Copier les fichiers de donnees ---
set "ok=0"
if exist "syndongo_data.json" (
    copy /Y "syndongo_data.json" "backups\syndongo_data_!stamp!.json" >nul
    echo   - syndongo_data.json sauvegarde
    set /a ok+=1
)
if exist "import_data_local.json" (
    copy /Y "import_data_local.json" "backups\import_data_local_!stamp!.json" >nul
    echo   - import_data_local.json sauvegarde
    set /a ok+=1
)

if !ok!==0 (
    echo [ATTENTION] Aucun fichier de donnees trouve.
    exit /b 1
)

REM --- Nettoyage : garder les 30 plus recents par fichier ---
echo.
echo [NETTOYAGE] Conservation des 30 dernieres sauvegardes...

for %%P in (syndongo_data import_data_local) do (
    set "count=0"
    for /f "delims=" %%F in ('dir /b /o-d "backups\%%P_*.json" 2^>nul') do (
        set /a count+=1
        if !count! GTR 30 (
            del "backups\%%F" 2>nul
        )
    )
)

echo.
echo [OK] Sauvegarde terminee : backups\
echo.

REM --- Mode silencieux si appele par tache planifiee (pas de pause) ---
if "%1"=="--silent" exit /b 0
if "%1"=="-s" exit /b 0

timeout /t 3 >nul
exit /b 0
