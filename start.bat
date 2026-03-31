@echo off
chcp 65001 >nul
echo.
echo  ================================
echo   SyNdongo - Demarrage
echo  ================================
echo.

node --version >nul 2>&1
if errorlevel 1 (
    echo ERREUR : Node.js non trouve.
    echo Installez Node.js sur https://nodejs.org
    pause
    exit /b 1
)

echo  Demarrage du serveur...
echo.
echo  Ouvrez votre navigateur sur :
echo  http://localhost:8000
echo.
echo  (Ne fermez pas cette fenetre)
echo.
node serveur.js
pause
