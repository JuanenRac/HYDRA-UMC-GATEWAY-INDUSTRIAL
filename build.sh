npm install
# HYDRA_UMC_SCRIPT_STANDARD_HEADER_BEGIN
# *****************************************************************************
# Project   : HYDRA-UMC-GATEWAY-INDUSTRIAL
# Script    : build.sh
# Purpose   : Incremental project build, verification and packaging workflow.
# Author    : JuanenRac (Electro Hobby 3D)
# Email     : electrohobby3d@gmail.com
# Copyright : (C) 2026 JuanenRac
# License   : GPL-3.0 - see LICENSE
# *****************************************************************************
# HYDRA_UMC_SCRIPT_STANDARD_HEADER_END
# HYDRA_UMC_SCRIPT_STANDARD_BANNER_BEGIN
printf '\n*******************************************************************************\n'
printf '%s\n' "* HYDRA-UMC-GATEWAY-INDUSTRIAL - build.sh"
printf '%s\n' "* Mode      : INCREMENTAL BUILD"
printf '%s\n' "* Author    : JuanenRac (Electro Hobby 3D)"
printf '%s\n' "* Email     : electrohobby3d@gmail.com"
printf '%s\n' "* Copyright : (C) 2026 JuanenRac"
printf '%s\n' "* License   : GPL-3.0 - see LICENSE"
printf '%s\n' "* ------------------------------------------------------------------------- *"
printf '%s\n' "* 1. Increment the project version and synchronise its manifest."
printf '%s\n' "* 2. Run this project's declared build, verification and packaging commands."
printf '%s\n' "* 3. Report the result and keep an interactive terminal open."
printf '%s\n' "*******************************************************************************"
printf '\n'
# HYDRA_UMC_SCRIPT_STANDARD_BANNER_END
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
  # HYDRA_UMC_SCRIPT_STANDARD_VERSION_STEP
  printf '%s\n' "[1/3] Incrementing project version and synchronising its manifest..."
  # HYDRA_UMC_SCRIPT_STANDARD_VERSION_CAPTURE_BEFORE
  HYDRA_UMC_VERSION_BEFORE="$(python3 -c 'import json, pathlib, sys; print(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["version"])' "$(dirname "$0")/hydra-umc.project.json")"
  python3 "$(dirname "$0")/bump_manifest_version.py" --sync || exit 1
  # HYDRA_UMC_SCRIPT_STANDARD_VERSION_CAPTURE_AFTER
  HYDRA_UMC_VERSION_AFTER="$(python3 -c 'import json, pathlib, sys; print(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["version"])' "$(dirname "$0")/hydra-umc.project.json")"
  printf '\n*******************************************************************************\n'
  printf '%s\n' '* VERSION INCREMENT COMPLETED'
  printf '%s\n' "* v${HYDRA_UMC_VERSION_BEFORE:-unknown} -> v${HYDRA_UMC_VERSION_AFTER:-unknown}"
  printf '%s\n' '* Project manifest has been synchronised by the project build flow.'
  printf '%s\n' '*******************************************************************************'
  printf '\n'
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
