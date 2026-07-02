/**
 * Capture-input validation with structured warnings.
 *
 * Goal: never silently drop a client's data. If a field is unknown or in the
 * wrong place, the response tells the client about it. Existing well-behaved
 * clients see `warnings: []` and nothing changes; legacy clients sending extra
 * fields keep working but learn what's being ignored / re-routed.
 *
 * This is shared by both the REST routes and the MCP tool handlers so they
 * give the same answer for the same input.
 */

export interface CaptureWarning {
  field: string;
  reason:
    | "unknown_field"
    | "deprecated_top_level"
    | "wrong_type"
    | "embedding_truncated";
  message: string;
  suggestion?: string;
}

/**
 * Approximate byte ceiling for the embedder's context window. Content above
 * this threshold is stored intact but only the first ~N bytes are reflected
 * in the embedding (semantic search will not match passages past the cutoff).
 *
 * Default tuned for Ollama `nomic-embed-text` (2048-token context, ~3 chars/
 * token for code-heavy markdown). Override via `OPENBRAIN_EMBED_SAFE_BYTES`.
 */
export function getEmbedSafeBytes(): number {
  const raw = process.env.OPENBRAIN_EMBED_SAFE_BYTES;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 6000;
}

export interface ValidatedCapture {
  content: string;
  source: string;
  project?: string;
  created_by?: string;
  supersedes?: string;
  /** Caller-provided metadata to merge on top of auto-extracted metadata. */
  metadata: Record<string, unknown>;
  warnings: CaptureWarning[];
}

/** Top-level keys the capture API recognises. */
const KNOWN_TOP_LEVEL = new Set([
  "content",
  "source",
  "project",
  "created_by",
  "supersedes",
  "metadata",
]);

/**
 * Top-level keys that *used* to be accepted as bare fields by older clients
 * (Plan-Forge, hallmark-stamped writers, etc.). We still accept them, but
 * route them into `metadata` and warn so callers can migrate to the nested
 * shape.
 */
const PROMOTABLE_TO_METADATA = new Set([
  "type",
  "topics",
  "people",
  "tags",
  "action_items",
  "captured_at",
  "expiresAt",
  "provenance",
  "hallmark",
]);

export interface ValidationOptions {
  /** Default value for `source` if the caller omits it. */
  defaultSource: string;
  /**
   * If true, `unknown_field` / `deprecated_top_level` / `wrong_type` warnings
   * become hard CaptureValidationError throws (= HTTP 400 / MCP isError) so
   * misbehaving clients see a real failure instead of a silently-dropped value.
   *
   * Defaults to the `OPENBRAIN_STRICT_INGEST` env var (`true` / `1` enable it).
   * Explicit option always wins over env.
   */
  strict?: boolean;
}

/** True when OPENBRAIN_STRICT_INGEST is set to "true" or "1". */
export function isStrictIngestEnabled(): boolean {
  const v = process.env.OPENBRAIN_STRICT_INGEST;
  return v === "true" || v === "1";
}

/** Render a list of warnings into a human-readable summary block. */
export function formatWarnings(warnings: CaptureWarning[]): string {
  if (warnings.length === 0) return "";
  const lines = warnings.map((w) => {
    const tail = w.suggestion ? ` ${w.suggestion}` : "";
    return `  \u2022 [${w.reason}] '${w.field}': ${w.message}${tail}`;
  });
  return `\u26a0\ufe0f Open Brain accepted this capture but flagged ${warnings.length} issue${warnings.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

/**
 * Emit one structured warning line per warning, tagged with caller context, so
 * an operator can see which clients are still sending malformed shapes.
 */
export function logWarnings(
  warnings: CaptureWarning[],
  ctx: { transport: "rest" | "mcp"; source: string; project?: string; created_by?: string },
): void {
  for (const w of warnings) {
    console.warn(
      `[ingest-warning] ${JSON.stringify({
        transport: ctx.transport,
        source: ctx.source,
        project: ctx.project ?? null,
        created_by: ctx.created_by ?? null,
        field: w.field,
        reason: w.reason,
        message: w.message,
      })}`,
    );
  }
}

/**
 * Validate a capture body. Always returns a ValidatedCapture — never throws
 * for shape issues. Throws only when `content` is missing or empty, which is
 * a hard 400.
 */
export function validateCaptureInput(
  raw: unknown,
  opts: ValidationOptions,
): ValidatedCapture {
  if (raw === null || typeof raw !== "object") {
    throw new CaptureValidationError("body must be a JSON object");
  }

  const strict = opts.strict ?? isStrictIngestEnabled();
  const body = raw as Record<string, unknown>;
  const warnings: CaptureWarning[] = [];

  const escalate = (w: CaptureWarning): void => {
    if (strict) {
      const tail = w.suggestion ? ` ${w.suggestion}` : "";
      throw new CaptureValidationError(`${w.message}${tail} (strict ingest mode)`);
    }
    warnings.push(w);
  };

  const content = body.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new CaptureValidationError("content is required and must be a non-empty string");
  }

  const source =
    body.source === undefined
      ? opts.defaultSource
      : typeof body.source === "string" && body.source.trim().length > 0
        ? body.source
        : (() => {
            throw new CaptureValidationError("source must be a non-empty string when provided");
          })();

  const project = strictOptionalString(body, "project");

  const VALID_NAMESPACES = ["dan", "family", "nicole", "system-cron", "gift-radar-cron"];
  if (body.created_by === undefined || body.created_by === null || body.created_by === "") {
    throw new CaptureValidationError(
      `created_by is required. Valid values: ${VALID_NAMESPACES.join(", ")}`
    );
  }
  if (typeof body.created_by !== "string" || !VALID_NAMESPACES.includes(body.created_by)) {
    throw new CaptureValidationError(
      `created_by '${body.created_by}' is not a recognized namespace. Valid values: ${VALID_NAMESPACES.join(", ")}`
    );
  }
  const created_by = body.created_by as string;

  let supersedes: string | undefined;
  if (body.supersedes !== undefined) {
    if (typeof body.supersedes !== "string" || !UUID_RE.test(body.supersedes)) {
      throw new CaptureValidationError("supersedes must be a valid UUID");
    }
    supersedes = body.supersedes;
  }

  const metadata: Record<string, unknown> = {};
  if (body.metadata !== undefined) {
    if (body.metadata === null || typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
      escalate({
        field: "metadata",
        reason: "wrong_type",
        message: "metadata was ignored because it must be a JSON object",
      });
    } else {
      Object.assign(metadata, body.metadata as Record<string, unknown>);
    }
  }

  for (const key of Object.keys(body)) {
    if (KNOWN_TOP_LEVEL.has(key)) continue;

    if (PROMOTABLE_TO_METADATA.has(key)) {
      // Don't clobber a value the caller already put under metadata.
      if (!(key in metadata)) {
        metadata[key] = body[key];
      }
      escalate({
        field: key,
        reason: "deprecated_top_level",
        message: `'${key}' was accepted but is deprecated at the top level — it has been moved into metadata.`,
        suggestion: `Send '${key}' inside the 'metadata' object instead.`,
      });
      continue;
    }

    escalate({
      field: key,
      reason: "unknown_field",
      message: `'${key}' was ignored because the capture API does not recognise it.`,
      suggestion: `Nest it under 'metadata' if you want it preserved, or remove it.`,
    });
  }

  // Embedding-context check. Informational only — not escalated in strict mode
  // because oversized content is a data property, not a shape bug. The full
  // content still gets stored; only the embedding is truncated by the model.
  const contentBytes = Buffer.byteLength(content, "utf8");
  const safeBytes = getEmbedSafeBytes();
  if (contentBytes > safeBytes) {
    metadata.embedding_truncated = true;
    metadata.embedding_indexed_bytes = safeBytes;
    metadata.content_bytes = contentBytes;
    warnings.push({
      field: "content",
      reason: "embedding_truncated",
      message: `Content is ${contentBytes} bytes; embedder will index only the first ~${safeBytes} bytes. Full content is stored, but semantic search may not match passages past byte ${safeBytes}.`,
      suggestion: `Split this into smaller captures (e.g. one per H3 section) if you need search coverage of the tail.`,
    });
  }

  return {
    content,
    source,
    project,
    created_by,
    supersedes,
    metadata,
    warnings,
  };
}

/**
 * Validate a batch body: { thoughts: [...], project?, source?, created_by?, metadata? }.
 * Top-level fields apply as defaults to every item. Each item gets its own
 * validation pass with its own warnings.
 */
export interface ValidatedBatch {
  items: ValidatedCapture[];
  /** Warnings about the batch envelope itself (not per item). */
  warnings: CaptureWarning[];
}

const BATCH_TOP_LEVEL = new Set([
  "thoughts",
  "project",
  "source",
  "created_by",
  "metadata",
]);

export function validateBatchInput(
  raw: unknown,
  opts: ValidationOptions,
): ValidatedBatch {
  if (raw === null || typeof raw !== "object") {
    throw new CaptureValidationError("body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  const thoughts = body.thoughts;
  if (!Array.isArray(thoughts) || thoughts.length === 0) {
    throw new CaptureValidationError("thoughts must be a non-empty array");
  }

  const strict = opts.strict ?? isStrictIngestEnabled();
  const envelopeWarnings: CaptureWarning[] = [];
  for (const key of Object.keys(body)) {
    if (BATCH_TOP_LEVEL.has(key)) continue;
    const w: CaptureWarning = {
      field: key,
      reason: "unknown_field",
      message: `'${key}' on the batch envelope was ignored.`,
    };
    if (strict) {
      throw new CaptureValidationError(`${w.message} (strict ingest mode)`);
    }
    envelopeWarnings.push(w);
  }

  const inheritedProject = strictOptionalString(body, "project");

  const VALID_NAMESPACES_BATCH = ["dan", "family", "nicole", "system-cron", "gift-radar-cron"];
  if (body.created_by === undefined || body.created_by === null || body.created_by === "") {
    throw new CaptureValidationError(
      `created_by is required on the batch envelope. Valid values: ${VALID_NAMESPACES_BATCH.join(", ")}`
    );
  }
  if (typeof body.created_by !== "string" || !VALID_NAMESPACES_BATCH.includes(body.created_by)) {
    throw new CaptureValidationError(
      `created_by '${body.created_by}' is not a recognized namespace. Valid values: ${VALID_NAMESPACES_BATCH.join(", ")}`
    );
  }
  const inheritedCreatedBy = body.created_by as string;
  const inheritedSource =
    body.source === undefined
      ? opts.defaultSource
      : typeof body.source === "string" && body.source.length > 0
        ? body.source
        : opts.defaultSource;
  const inheritedMetadata =
    body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : {};

  const items: ValidatedCapture[] = thoughts.map((t, i) => {
    if (t === null || typeof t !== "object") {
      throw new CaptureValidationError(`thoughts[${i}] must be a JSON object`);
    }
    const merged = {
      // batch-level defaults first, then per-item overrides
      project: inheritedProject,
      created_by: inheritedCreatedBy,
      source: inheritedSource,
      metadata: { ...inheritedMetadata },
      ...(t as Record<string, unknown>),
    };
    return validateCaptureInput(merged, { defaultSource: inheritedSource, strict });
  });

  return { items, warnings: envelopeWarnings };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CaptureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureValidationError";
  }
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
  warnings: CaptureWarning[],
): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.trim().length === 0) {
    warnings.push({
      field: key,
      reason: "wrong_type",
      message: `'${key}' was ignored because it must be a non-empty string.`,
    });
    return undefined;
  }
  return v;
}

/**
 * Stricter form: throws CaptureValidationError (= HTTP 400) if the field is
 * present but not a non-empty string. Use for known fields where a malformed
 * value is almost certainly a caller bug we want to surface loudly.
 */
function strictOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new CaptureValidationError(`${key} must be a non-empty string`);
  }
  return v;
}
