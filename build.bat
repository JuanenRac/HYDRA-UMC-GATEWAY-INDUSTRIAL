@echo off
REM =============================================================================
REM HYDRA-UMC GATEWAY INDUSTRIAL - Build and Compile Script
REM Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
REM GPL-3.0 - see LICENSE
REM =============================================================================
echo ========================================
echo  HYDRA-UMC GATEWAY INDUSTRIAL
echo  Build and Compile Script - installs dependencies and compiles the app
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

echo ========================================
echo  Running the real test suite (vitest)...
echo ========================================
call npm test
if errorlevel 1 (
  echo.
  echo TESTS FAILED.
  pause
  exit /b 1
)

echo ========================================
echo  Compiling HYDRA-UMC GATEWAY INDUSTRIAL (Prod Mode)
echo ========================================
call npm run build
if errorlevel 1 (
  echo.
  echo Build FAILED.
  pause
  exit /b 1
)
REM npm run build bumps package.json's own native version FIRST (see
REM scripts/bump-version.mjs), then bundles - so the manifest sync runs
REM AFTER, with --sync, accepting that one real native bump rather than
REM bumping the native version a second time itself.
python "%~dp0bump_manifest_version.py" --sync
if errorlevel 1 ( echo VERSION SYNC FAILED. & pause & exit /b 1 )
echo.
echo Build complete! You can now start the production server with:
echo npm start
pause
