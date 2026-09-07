// =============================================================================
// HYDRA-UMC GATEWAY INDUSTRIAL - tests/command.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real unit tests for CommandDispatcher: no HTTP, no network - exercises
// the allowlist/backpressure/timeout decision layer directly against
// controllable fake executors.
// =============================================================================

import { describe, expect, it } from "vitest";
import { CommandDispatcher, DEFAULT_ALLOWLIST, type CommandRequest } from "../src/command.js";

function req(overrides: Partial<CommandRequest> = {}): CommandRequest {
  return { protocol: "OPC-UA", operation: "read", target: "ns=2;s=Line1.Status", ...overrides };
}

describe("CommandDispatcher authorization (default-deny allowlist)", () => {
  it("accepts an operation that is explicitly allowlisted", async () => {
    const dispatcher = new CommandDispatcher({ executor: async () => ({ ok: true }) });
    const outcome = await dispatcher.dispatch(req({ protocol: "OPC-UA", operation: "read" }));
    expect(outcome.status).toBe("accepted");
  });

  it("rejects an operation that is not on the allowlist for its protocol", async () => {
    const dispatcher = new CommandDispatcher({ executor: async () => ({ ok: true }) });
    const outcome = await dispatcher.dispatch(req({ protocol: "OPC-UA", operation: "write" }));
    expect(outcome.status).toBe("rejected_unauthorized");
    if (outcome.status === "rejected_unauthorized") {
      expect(outcome.reason).toContain("write");
      expect(outcome.reason).toContain("OPC-UA");
    }
  });

  it("rejects an operation that is allowlisted for a DIFFERENT protocol", async () => {
    // "publish" is allowed for MQTT, not OPC-UA - the allowlist must be
    // checked per protocol, not as one global set of allowed verbs.
    const dispatcher = new CommandDispatcher({ executor: async () => ({ ok: true }) });
    const outcome = await dispatcher.dispatch(req({ protocol: "OPC-UA", operation: "publish" }));
    expect(outcome.status).toBe("rejected_unauthorized");
  });

  it("default allowlist never includes a write-like operation for any protocol", () => {
    // The real safety property: v0 must not silently allow anything that
    // could alter a live PLC's state.
    for (const ops of Object.values(DEFAULT_ALLOWLIST)) {
      expect(ops.has("write")).toBe(false);
      expect(ops.has("execute")).toBe(false);
      expect(ops.has("reboot")).toBe(false);
    }
  });

  it("unauthorized rejection never invokes the executor", async () => {
    let called = false;
    const dispatcher = new CommandDispatcher({
      executor: async () => {
        called = true;
        return { ok: true };
      },
    });
    await dispatcher.dispatch(req({ operation: "not-a-real-operation" }));
    expect(called).toBe(false);
  });
});

describe("CommandDispatcher backpressure", () => {
  it("rejects a command once maxConcurrent in-flight commands are already running", async () => {
    let releaseFirst: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const dispatcher = new CommandDispatcher({
      maxConcurrent: 1,
      executor: async () => {
        await blocked;
        return { ok: true };
      },
    });

    const first = dispatcher.dispatch(req());
    // Give the first dispatch a tick to actually register as in-flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatcher.inFlightCount).toBe(1);

    const second = await dispatcher.dispatch(req());
    expect(second.status).toBe("rejected_backpressure");
    if (second.status === "rejected_backpressure") {
      expect(second.reason).toContain("limit 1");
    }

    releaseFirst();
    const firstOutcome = await first;
    expect(firstOutcome.status).toBe("accepted");
  });

  it("frees a capacity slot once a command completes, allowing the next one through", async () => {
    const dispatcher = new CommandDispatcher({ maxConcurrent: 1, executor: async () => ({ ok: true }) });
    const first = await dispatcher.dispatch(req());
    expect(first.status).toBe("accepted");
    expect(dispatcher.inFlightCount).toBe(0);

    const second = await dispatcher.dispatch(req());
    expect(second.status).toBe("accepted");
  });

  it("authorization is checked before capacity - an unauthorized command is rejected the same way regardless of load", async () => {
    let releaseFirst: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const dispatcher = new CommandDispatcher({
      maxConcurrent: 1,
      executor: async () => {
        await blocked;
        return { ok: true };
      },
    });
    const first = dispatcher.dispatch(req());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const unauthorized = await dispatcher.dispatch(req({ operation: "write" }));
    expect(unauthorized.status).toBe("rejected_unauthorized");

    releaseFirst();
    await first;
  });
});

describe("CommandDispatcher timeout", () => {
  it("reports a timeout when the executor never resolves within the budget", async () => {
    const dispatcher = new CommandDispatcher({
      executor: () => new Promise(() => {}), // never resolves
    });
    const outcome = await dispatcher.dispatch(req({ timeoutMs: 20 }));
    expect(outcome.status).toBe("timeout");
    if (outcome.status === "timeout") {
      expect(outcome.reason).toContain("20ms");
    }
  });

  it("keeps capacity reserved after a timeout until the real executor settles", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<{ ok: boolean }>((resolve) => {
      release = () => resolve({ ok: true });
    });
    const dispatcher = new CommandDispatcher({
      maxConcurrent: 1,
      executor: () => blocked,
    });
    await dispatcher.dispatch(req({ timeoutMs: 10 }));
    expect(dispatcher.inFlightCount).toBe(1);

    const next = await dispatcher.dispatch(req({ operation: "read", timeoutMs: 10 }));
    expect(next.status).toBe("rejected_backpressure");

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatcher.inFlightCount).toBe(0);

    const afterSettlement = await dispatcher.dispatch(req({ timeoutMs: 100 }));
    expect(afterSettlement.status).toBe("accepted");
  });

  it("observes a late executor rejection after a response timeout", async () => {
    let reject: (reason?: unknown) => void = () => {};
    const blocked = new Promise<{ ok: boolean }>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const dispatcher = new CommandDispatcher({ maxConcurrent: 1, executor: () => blocked });
      expect((await dispatcher.dispatch(req({ timeoutMs: 10 }))).status).toBe("timeout");
      reject(new Error("late downstream failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(dispatcher.inFlightCount).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("a command that resolves within its timeout is accepted, not timed out", async () => {
    const dispatcher = new CommandDispatcher({
      executor: async () => ({ ok: true }),
    });
    const outcome = await dispatcher.dispatch(req({ timeoutMs: 1000 }));
    expect(outcome.status).toBe("accepted");
  });
});

describe("CommandDispatcher executor rejection", () => {
  it("surfaces a rejecting executor as a real error, not a masked timeout", async () => {
    const dispatcher = new CommandDispatcher({
      executor: async () => {
        throw new Error("simulated protocol-level write failure");
      },
    });
    const outcome = await dispatcher.dispatch(req({ timeoutMs: 1000 }));
    expect(outcome.status).toBe("executor_error");
    expect(outcome.status).not.toBe("timeout");
    if (outcome.status === "executor_error") {
      expect(outcome.reason).toContain("simulated protocol-level write failure");
    }
  });

  it("a rejecting executor does not produce an unhandled promise rejection", async () => {
    // Real regression coverage for the withTimeout() bug: the wrapping
    // promise used to have no reject path, so a throwing executor's
    // rejection was left unhandled - which crashes the process by
    // default under modern Node. Install a real listener and assert it
    // never fires, rather than trusting that no crash means no bug.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const dispatcher = new CommandDispatcher({
        executor: async () => {
          throw new Error("simulated protocol-level write failure");
        },
      });
      const outcome = await dispatcher.dispatch(req({ timeoutMs: 1000 }));
      expect(outcome.status).toBe("executor_error");
      // Give any lingering unhandled rejection a real chance to surface
      // before asserting none did.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("still frees its in-flight slot after the executor rejects", async () => {
    const dispatcher = new CommandDispatcher({
      maxConcurrent: 1,
      executor: async () => {
        throw new Error("simulated failure");
      },
    });
    await dispatcher.dispatch(req());
    expect(dispatcher.inFlightCount).toBe(0);
  });
});

describe("CommandDispatcher downstream outcome", () => {
  it("reports downstream_unreachable when the executor confirms failure", async () => {
    const dispatcher = new CommandDispatcher({
      executor: async () => ({ ok: false, detail: "HYDRA-UMC-OPCUA-SERVER is not reachable" }),
    });
    const outcome = await dispatcher.dispatch(req());
    expect(outcome.status).toBe("downstream_unreachable");
    if (outcome.status === "downstream_unreachable") {
      expect(outcome.reason).toContain("not reachable");
    }
  });
});
