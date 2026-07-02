/**
 * Unit tests for the lsje39 scope gates in src/mcp/server.ts:
 *   enforceRead  (D-103 reads + D-112 thought_stats)
 *   rejectWrite  (D-112 writes: capture/update/delete)
 *
 * These are the fork's load-bearing local changes (OpenAssistant docs/26 §7,
 * decisions D-103/D-112) — the matrix below is the regression net for upstream
 * syncs (see FORK.md). The flag is passed explicitly per case; the live flag
 * flip itself is verified end-to-end by scripts/mcp-scope-probe.py in the
 * OpenAssistant repo.
 */

import { describe, it, expect, vi } from "vitest";

// Mock heavyweight module-level deps, same pattern as server.test.ts.
vi.mock("../../db/connection.js", () => ({
  getPool: () => ({ query: vi.fn(), connect: vi.fn() }),
}));

vi.mock("../../embedder/index.js", () => ({
  getEmbedder: () => ({
    generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
    extractMetadata: vi.fn().mockResolvedValue({
      type: "observation",
      topics: [],
      people: [],
      action_items: [],
      dates: [],
    }),
  }),
}));

import { enforceRead, rejectWrite, type AgentIdentity } from "../server.js";

const dan: AgentIdentity = { agent: "dan", read_scope: ["dan", "family"] };
const nicole: AgentIdentity = { agent: "nicole", read_scope: ["family", "nicole"] };
const emptyScope: AgentIdentity = { agent: "ghost", read_scope: [] };

describe("enforceRead (D-103)", () => {
  it("passes reads through untouched when there is no identity (legacy caller)", () => {
    expect(enforceRead(undefined, "dan", true)).toEqual({ reject: false, namespaces: ["dan"] });
    expect(enforceRead(undefined, undefined, true)).toEqual({
      reject: false,
      namespaces: undefined,
    });
  });

  it("blocks nothing in shadow mode, even out of scope", () => {
    expect(enforceRead(nicole, "dan", false)).toEqual({ reject: false, namespaces: ["dan"] });
    expect(enforceRead(nicole, undefined, false)).toEqual({
      reject: false,
      namespaces: undefined,
    });
  });

  it("narrows an UNSET read to the caller's full read_scope (the briefing union)", () => {
    expect(enforceRead(dan, undefined, true)).toEqual({
      reject: false,
      namespaces: ["dan", "family"],
    });
  });

  it("passes an explicit in-scope read through as a single namespace", () => {
    expect(enforceRead(dan, "dan", true)).toEqual({ reject: false, namespaces: ["dan"] });
    expect(enforceRead(dan, "family", true)).toEqual({ reject: false, namespaces: ["family"] });
    expect(enforceRead(nicole, "nicole", true)).toEqual({ reject: false, namespaces: ["nicole"] });
  });

  it("rejects an explicit cross-person read, both directions", () => {
    expect(enforceRead(nicole, "dan", true)).toEqual({ reject: true, namespaces: undefined });
    expect(enforceRead(dan, "nicole", true)).toEqual({ reject: true, namespaces: undefined });
  });

  it("D-105 regression: 'system'-authored rows are invisible to a scoped agent", () => {
    // Why Nicole's brief came in bare (D-105): her prefetch row was authored
    // created_by='system', which is outside [family, nicole]. The fix was
    // data-side (author per-person data in that person's namespace) — the
    // filter is CORRECT to reject here, and must keep rejecting.
    expect(enforceRead(nicole, "system", true)).toEqual({ reject: true, namespaces: undefined });
    // Her unset briefing read unions her own scope — 'system' is not in it.
    expect(enforceRead(nicole, undefined, true).namespaces).not.toContain("system");
  });

  it("fails safe on an empty read_scope: unset narrows to nothing, explicit rejects", () => {
    expect(enforceRead(emptyScope, undefined, true)).toEqual({ reject: false, namespaces: [] });
    expect(enforceRead(emptyScope, "dan", true)).toEqual({ reject: true, namespaces: undefined });
  });

  it("defaults to the SCOPE_ENFORCE env flag (unset here = shadow passthrough)", () => {
    // The test env does not set SCOPE_ENFORCE; the default must be shadow.
    expect(enforceRead(nicole, "dan")).toEqual({ reject: false, namespaces: ["dan"] });
  });
});

describe("rejectWrite (D-112)", () => {
  it("rejects nothing in shadow mode or without an identity", () => {
    expect(rejectWrite(nicole, "dan", false)).toBe(false);
    expect(rejectWrite(undefined, "dan", true)).toBe(false);
  });

  it("rejects a write with no created_by defensively", () => {
    expect(rejectWrite(dan, undefined, true)).toBe(true);
  });

  it("allows writes into the caller's own scope (own + family)", () => {
    expect(rejectWrite(dan, "dan", true)).toBe(false);
    expect(rejectWrite(dan, "family", true)).toBe(false);
    expect(rejectWrite(nicole, "nicole", true)).toBe(false);
    expect(rejectWrite(nicole, "family", true)).toBe(false);
  });

  it("rejects cross-person writes, both directions", () => {
    expect(rejectWrite(nicole, "dan", true)).toBe(true);
    expect(rejectWrite(dan, "nicole", true)).toBe(true);
  });

  it("fails safe on an empty read_scope: every write rejected", () => {
    expect(rejectWrite(emptyScope, "family", true)).toBe(true);
  });

  it("defaults to the SCOPE_ENFORCE_WRITES env flag (unset here = shadow)", () => {
    expect(rejectWrite(nicole, "dan")).toBe(false);
  });
});
