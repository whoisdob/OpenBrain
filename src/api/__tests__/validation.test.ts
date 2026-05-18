/**
 * Tests for the strict-ingest mode + warning helpers added in v0.7.2.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  validateCaptureInput,
  validateBatchInput,
  CaptureValidationError,
  formatWarnings,
  logWarnings,
  isStrictIngestEnabled,
} from "../validation.js";

describe("validation: strict ingest mode", () => {
  const opts = { defaultSource: "test" };

  it("accepts unknown fields with a warning when strict is off", () => {
    const result = validateCaptureInput(
      { content: "hello", _v: 1, totally_bogus: "x" },
      { ...opts, strict: false },
    );
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]!.reason).toBe("unknown_field");
    expect(result.warnings[1]!.reason).toBe("unknown_field");
  });

  it("throws on unknown fields when strict is on", () => {
    expect(() =>
      validateCaptureInput({ content: "hello", _v: 1 }, { ...opts, strict: true }),
    ).toThrow(CaptureValidationError);
  });

  it("throws on deprecated top-level fields when strict is on", () => {
    expect(() =>
      validateCaptureInput(
        { content: "hello", type: "decision" },
        { ...opts, strict: true },
      ),
    ).toThrow(/deprecated/);
  });

  it("throws on bad metadata type when strict is on", () => {
    expect(() =>
      validateCaptureInput(
        { content: "hello", metadata: "not-an-object" },
        { ...opts, strict: true },
      ),
    ).toThrow(/metadata/);
  });

  it("escalates batch envelope warnings when strict is on", () => {
    expect(() =>
      validateBatchInput(
        { thoughts: [{ content: "x" }], bogus_envelope_key: true },
        { ...opts, strict: true },
      ),
    ).toThrow(/bogus_envelope_key/);
  });

  it("escalates per-item warnings when strict is on", () => {
    expect(() =>
      validateBatchInput(
        { thoughts: [{ content: "ok" }, { content: "bad", _v: 1 }] },
        { ...opts, strict: true },
      ),
    ).toThrow(CaptureValidationError);
  });

  it("respects OPENBRAIN_STRICT_INGEST env var when option omitted", () => {
    const old = process.env.OPENBRAIN_STRICT_INGEST;
    try {
      process.env.OPENBRAIN_STRICT_INGEST = "true";
      expect(isStrictIngestEnabled()).toBe(true);
      expect(() =>
        validateCaptureInput({ content: "hello", _v: 1 }, opts),
      ).toThrow(CaptureValidationError);

      process.env.OPENBRAIN_STRICT_INGEST = "false";
      expect(isStrictIngestEnabled()).toBe(false);
      const result = validateCaptureInput({ content: "hello", _v: 1 }, opts);
      expect(result.warnings).toHaveLength(1);

      delete process.env.OPENBRAIN_STRICT_INGEST;
      expect(isStrictIngestEnabled()).toBe(false);
    } finally {
      if (old === undefined) delete process.env.OPENBRAIN_STRICT_INGEST;
      else process.env.OPENBRAIN_STRICT_INGEST = old;
    }
  });

  it("explicit strict:false overrides env strict:true", () => {
    const old = process.env.OPENBRAIN_STRICT_INGEST;
    try {
      process.env.OPENBRAIN_STRICT_INGEST = "true";
      const result = validateCaptureInput(
        { content: "hello", _v: 1 },
        { ...opts, strict: false },
      );
      expect(result.warnings).toHaveLength(1);
    } finally {
      if (old === undefined) delete process.env.OPENBRAIN_STRICT_INGEST;
      else process.env.OPENBRAIN_STRICT_INGEST = old;
    }
  });
});

describe("validation: formatWarnings", () => {
  it("returns empty string for no warnings", () => {
    expect(formatWarnings([])).toBe("");
  });

  it("renders one warning with reason, field, message, suggestion", () => {
    const out = formatWarnings([
      {
        field: "_v",
        reason: "unknown_field",
        message: "'_v' was ignored.",
        suggestion: "Nest it under metadata.",
      },
    ]);
    expect(out).toContain("1 issue");
    expect(out).toContain("[unknown_field]");
    expect(out).toContain("'_v'");
    expect(out).toContain("Nest it under metadata.");
  });

  it("pluralises and lists multiple warnings", () => {
    const out = formatWarnings([
      { field: "a", reason: "unknown_field", message: "x" },
      { field: "b", reason: "deprecated_top_level", message: "y" },
    ]);
    expect(out).toContain("2 issues");
    expect(out).toContain("'a'");
    expect(out).toContain("'b'");
  });
});

describe("validation: logWarnings", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("emits one [ingest-warning] line per warning with caller context", () => {
    logWarnings(
      [
        { field: "_v", reason: "unknown_field", message: "ignored" },
        { field: "type", reason: "deprecated_top_level", message: "moved" },
      ],
      { transport: "mcp", source: "plan-forge", project: "pf", created_by: "scott" },
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const first = warnSpy.mock.calls[0][0] as string;
    expect(first).toMatch(/^\[ingest-warning\] /);
    const payload = JSON.parse(first.replace(/^\[ingest-warning\] /, ""));
    expect(payload).toMatchObject({
      transport: "mcp",
      source: "plan-forge",
      project: "pf",
      created_by: "scott",
      field: "_v",
      reason: "unknown_field",
    });
  });

  it("emits nothing when warnings array is empty", () => {
    logWarnings([], { transport: "rest", source: "api" });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("validation: embedding truncation warning", () => {
  const opts = { defaultSource: "test", strict: false };
  const SAFE = 6000;

  beforeEach(() => {
    delete process.env.OPENBRAIN_EMBED_SAFE_BYTES;
  });

  it("does not warn when content is at or below the safe ceiling", () => {
    const result = validateCaptureInput({ content: "x".repeat(SAFE) }, opts);
    expect(result.warnings).toHaveLength(0);
    expect(result.metadata.embedding_truncated).toBeUndefined();
    expect(result.metadata.embedding_indexed_bytes).toBeUndefined();
  });

  it("warns and tags metadata when content exceeds the safe ceiling", () => {
    const big = "x".repeat(SAFE + 500);
    const result = validateCaptureInput({ content: big }, opts);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.reason).toBe("embedding_truncated");
    expect(result.warnings[0]!.field).toBe("content");
    expect(result.warnings[0]!.message).toMatch(/6500 bytes/);
    expect(result.metadata.embedding_truncated).toBe(true);
    expect(result.metadata.embedding_indexed_bytes).toBe(SAFE);
    expect(result.metadata.content_bytes).toBe(SAFE + 500);
  });

  it("never escalates the truncation warning under strict mode", () => {
    const big = "x".repeat(SAFE + 1);
    const result = validateCaptureInput({ content: big }, { defaultSource: "test", strict: true });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.reason).toBe("embedding_truncated");
  });

  it("honours OPENBRAIN_EMBED_SAFE_BYTES override", () => {
    process.env.OPENBRAIN_EMBED_SAFE_BYTES = "100";
    const result = validateCaptureInput({ content: "x".repeat(200) }, opts);
    expect(result.warnings).toHaveLength(1);
    expect(result.metadata.embedding_indexed_bytes).toBe(100);
    expect(result.metadata.content_bytes).toBe(200);
  });
});
