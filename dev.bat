@echo off
REM =============================================================================
REM HYDRA-UMC GATEWAY INDUSTRIAL - Development Server Start Script
REM Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
REM GPL-3.0 - see LICENSE
REM =============================================================================

echo ========================================
echo  HYDRA-UMC GATEWAY INDUSTRIAL
echo  Development Server Start Script - installs dependencies and starts the dev server
echo  Author: JuanenRac (Electro Hobby 3D)
echo  E-mail: electrohobby3d@gmail.com
echo  License: GPL-3.0 - see LICENSE
echo ========================================
echo.

echo ========================================
echo  Installing dependencies...
echo ========================================
call npm install
call npm install-scripts approve --all
call npm audit fix

echo ========================================
echo  Starting HYDRA-UMC GATEWAY INDUSTRIAL (Dev Mode)
echo ========================================
REM The gateway refuses to start without GATEWAY_JWT_SECRET; a development run says on purpose that it is an open lab gateway (it listens on 127.0.0.1 only).
if not defined GATEWAY_ALLOW_ANONYMOUS set "GATEWAY_ALLOW_ANONYMOUS=1"
call npm run dev
if errorlevel 1 (
  echo.
  echo HYDRA-UMC GATEWAY INDUSTRIAL exited with an error.
  pause
  exit /b 1
)
pause
