#!/bin/bash
# =============================================================================
# HYDRA-UMC GATEWAY INDUSTRIAL - Build and Compile Script
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0 - see LICENSE
# =============================================================================
echo "========================================"
echo " HYDRA-UMC GATEWAY INDUSTRIAL"
echo " Build and Compile Script - installs dependencies and compiles the app"
echo " Author: JuanenRac (Electro Hobby 3D)"
echo " E-mail: electrohobby3d@gmail.com"
echo " License: GPL-3.0 - see LICENSE"
echo "========================================"
echo ""

echo "========================================"
echo " Installing dependencies... "
echo "========================================"
npm install
npm install-scripts approve --all

echo "========================================"
echo " Running the real test suite (vitest)... "
echo "========================================"
if ! npm test; then
  echo ""
  echo "TESTS FAILED."
  read -p "Press Enter to close..."
  exit 1
fi

echo "========================================"
echo " Compiling HYDRA-UMC GATEWAY INDUSTRIAL (Prod Mode) "
echo "========================================"
# npm run build bumps package.json's own native version FIRST (see
# scripts/bump-version.mjs), then bundles - so the manifest sync below
# runs AFTER, with --sync, accepting that one real native bump rather
# than bumping the native version a second time itself.
if npm run build; then
  python3 "$(dirname "$0")/bump_manifest_version.py" --sync || exit 1
  echo ""
  echo "Build complete! You can now start the production server with:"
  echo "npm start"
  read -p "Press Enter to close..."
else
  echo ""
  echo "Build FAILED."
  read -p "Press Enter to close..."
  exit 1
fi
