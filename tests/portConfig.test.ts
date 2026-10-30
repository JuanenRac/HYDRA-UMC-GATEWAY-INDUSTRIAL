// =============================================================================
// HYDRA-UMC-GATEWAY-INDUSTRIAL - tests/portConfig.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================

import { describe, expect, it } from "vitest";
import { resolveServicePort } from "../src/portConfig.js";

describe("resolveServicePort", () => {
  it("prefers the variable of the service over the shared PORT, without a warning", () => {
    const r = resolveServicePort({ HYDRA_UMC_GATEWAY_PORT: "8100", PORT: "3000" }, "HYDRA_UMC_GATEWAY_PORT", 1);
    expect(r).toEqual({ port: 8100, source: "specific" });
  });

  it("still honours the shared PORT, but warns", () => {
    const r = resolveServicePort({ PORT: "3000" }, "HYDRA_UMC_GATEWAY_PORT", 1);
    expect(r.port).toBe(3000);
    expect(r.source).toBe("PORT");
    expect(r.warning).toContain("HYDRA_UMC_GATEWAY_PORT");
  });

  it("falls back to the default when nothing valid is set", () => {
    expect(resolveServicePort({}, "HYDRA_UMC_GATEWAY_PORT", 8000)).toEqual({ port: 8000, source: "default" });
    expect(resolveServicePort({ HYDRA_UMC_GATEWAY_PORT: "abc", PORT: "70000" }, "HYDRA_UMC_GATEWAY_PORT", 8000).port).toBe(8000);
    expect(resolveServicePort({ HYDRA_UMC_GATEWAY_PORT: "", PORT: "0" }, "HYDRA_UMC_GATEWAY_PORT", 8000).source).toBe("default");
  });

  it("ignores an invalid specific value in favour of a valid shared one", () => {
    expect(resolveServicePort({ HYDRA_UMC_GATEWAY_PORT: "x", PORT: "4000" }, "HYDRA_UMC_GATEWAY_PORT", 8000).port).toBe(4000);
  });
});
