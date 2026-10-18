#!/bin/bash
# =============================================================================
# HYDRA-UMC GATEWAY INDUSTRIAL - Development Server Start Script
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0-or-later - see LICENSE
# =============================================================================

echo "========================================"
echo " HYDRA-UMC GATEWAY INDUSTRIAL"
echo " Development Server Start Script - installs dependencies and starts the dev server"
echo " Author: JuanenRac (Electro Hobby 3D)"
echo " E-mail: electrohobby3d@gmail.com"
echo " License: GPL-3.0-or-later - see LICENSE"
echo "========================================"
echo ""

echo "========================================"
echo " Installing dependencies... "
echo "========================================"
npm install
npm install-scripts approve --all

echo "========================================"
echo " Starting HYDRA-UMC GATEWAY INDUSTRIAL (Dev Mode) "
echo "========================================"
# The gateway refuses to start without GATEWAY_JWT_SECRET; a development run says on purpose that it is an open lab gateway (it listens on 127.0.0.1 only).
export GATEWAY_ALLOW_ANONYMOUS="${GATEWAY_ALLOW_ANONYMOUS:-1}"
if npm run dev; then
  if [ -t 0 ] && [ "${HYDRA_UMC_CI:-}" != "1" ] && [ -z "${CI:-}" ]; then read -r -p "Press Enter to close..." _ || true; fi
else
  echo ""
  echo "HYDRA-UMC GATEWAY INDUSTRIAL exited with an error."
  if [ -t 0 ] && [ "${HYDRA_UMC_CI:-}" != "1" ] && [ -z "${CI:-}" ]; then read -r -p "Press Enter to close..." _ || true; fi
  exit 1
fi
