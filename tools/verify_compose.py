#!/usr/bin/env python3
# HYDRA-UMC-GATEWAY-INDUSTRIAL - tools/verify_compose.py
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0-or-later - see LICENSE
"""Static checks of docker-compose.yml and the Dockerfile, runnable without Docker or PyYAML.

`docker compose config` accepts a stack that starts an open API, runs as root
or never reports itself healthy just as readily as a correct one, so the things
that went wrong before are checked here:

  * every service restarts on failure (`restart:`);
  * a secret the stack cannot run safely without is `${VAR:?message}`; an
    optional one passed through is `${VAR:-}` (empty = not configured); no
    secret is ever a literal or has a non-empty default;
  * every name in `depends_on` is a service of the stack;
  * the gateway service has a healthcheck;
  * every named volume a service mounts is declared;
  * the Dockerfile runs the final stage as an unprivileged user, has a
    HEALTHCHECK, installs from the lockfile (`npm ci`) and does not use a
    floating `latest` tag.

Published ports are only listed (`COMPOSE_NOTE`): how widely a port is exposed is a
deployment decision, not something this check can judge.

Exit status 0 and `COMPOSE_CHECK=PASS` when everything holds.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = ROOT / "docker-compose.yml"
DOCKERFILE = ROOT / "Dockerfile"
SECRET_NAME = re.compile(r"(SECRET|PASSWORD|TOKEN|AUTH_JSON|ACL_JSON)")


def service_blocks(text: str) -> dict[str, list[str]]:
    blocks: dict[str, list[str]] = {}
    in_services = False
    current: str | None = None
    for line in text.splitlines():
        if re.match(r"^\S", line):
            in_services = line.startswith("services:")
            current = None
            continue
        if not in_services:
            continue
        m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if m:
            current = m.group(1)
            blocks[current] = []
        elif current is not None:
            blocks[current].append(line)
    return blocks


def top_level_names(text: str, section: str) -> set[str]:
    names: set[str] = set()
    in_section = False
    for line in text.splitlines():
        if re.match(r"^\S", line):
            in_section = line.startswith(f"{section}:")
            continue
        m = re.match(r"^  ([A-Za-z0-9_-]+):", line)
        if in_section and m:
            names.add(m.group(1))
    return names


def main() -> int:
    text = COMPOSE.read_text(encoding="utf-8")
    problems: list[str] = []
    notes: list[str] = []
    blocks = service_blocks(text)
    if not blocks:
        problems.append("no services found")
    volumes = top_level_names(text, "volumes")

    for name, lines in blocks.items():
        body = "\n".join(lines)
        if not re.search(r"^    restart:", body, re.M):
            problems.append(f"{name}: no restart: policy")
        for m in re.finditer(r"^\s+- ([A-Z][A-Z0-9_]*)=(.*)$", body, re.M):
            var, value = m.group(1), m.group(2).strip()
            if SECRET_NAME.search(var):
                if not (value.startswith("${") and (":?" in value or value.endswith(":-}"))):
                    problems.append(f"{name}: {var} must be ${{VAR:?message}} (required) or ${{VAR:-}} (optional), got {value!r}")
        for m in re.finditer(r"^      - ([A-Za-z0-9_-]+):/", body, re.M):
            if m.group(1) not in volumes:
                problems.append(f"{name}: mounts the named volume {m.group(1)}, which is not declared under volumes:")
        depends = re.search(r"^    depends_on:\s*\n((?:      - .*\n?)+)", body + "\n", re.M)
        if depends:
            for dep in re.findall(r"- ([A-Za-z0-9_-]+)", depends.group(1)):
                if dep not in blocks:
                    problems.append(f"{name}: depends_on {dep}, which is not a service")
        in_ports = False
        for line in lines:
            if re.match(r"^    ports:", line):
                in_ports = True
                continue
            if in_ports:
                item = re.match(r"^      - \"?([^\"]+)\"?\s*$", line)
                if not item:
                    in_ports = False
                    continue
                if not item.group(1).startswith("127.0.0.1:"):
                    notes.append(f"{name}: port {item.group(1)} is published on every interface of the host")

    gateway = "\n".join(blocks.get("gateway-industrial", []))
    if not re.search(r"^    healthcheck:", gateway, re.M):
        problems.append("gateway-industrial: no healthcheck")
    if "GATEWAY_JWT_SECRET=${GATEWAY_JWT_SECRET:?" not in gateway:
        problems.append("gateway-industrial: GATEWAY_JWT_SECRET must be required with ${GATEWAY_JWT_SECRET:?message}")

    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    final_stage = dockerfile.split("FROM ")[-1]
    if not re.search(r"^USER\s+\S+", final_stage, re.M) or re.search(r"^USER\s+(root|0)\b", final_stage, re.M):
        problems.append("Dockerfile: the final stage must run as an unprivileged USER")
    if "HEALTHCHECK" not in final_stage:
        problems.append("Dockerfile: the final stage has no HEALTHCHECK")
    if re.search(r"^RUN npm install\b", dockerfile, re.M):
        problems.append("Dockerfile: use `npm ci` (the lockfile), not `npm install`")
    for image in re.findall(r"^\s*FROM\s+(\S+)", dockerfile, re.M):
        tag = image.split(":", 1)[1] if ":" in image else "latest"
        if tag == "latest":
            problems.append(f"Dockerfile: image {image} is floating")
    if re.search(r"^RUN .*npm run build\b", dockerfile, re.M):
        problems.append("Dockerfile: `npm run build` bumps the version; the image must run `npm run bundle`")

    for note in notes:
        print(f"COMPOSE_NOTE {note}")
    if problems:
        for problem in problems:
            print(f"COMPOSE_CHECK problem: {problem}")
        print("COMPOSE_CHECK=FAIL")
        return 1
    print(f"COMPOSE_CHECK=PASS services={len(blocks)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
