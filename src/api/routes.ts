/**
 * REST API routes using Hono.
 * Provides /health, /memories, /memories/search, /memories/list, /memories/batch,
 * /memories/:id (PUT, DELETE), /stats endpoints.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { getPool } from "../db/connection.js";
import {
  insertThought,
  searchThoughts,
  listThoughts,
  getThoughtStats,
  updateThought,
  deleteThought,
  batchInsertThoughts,
  searchThoughtsBySource,
  type ListFilters,
  type BatchThoughtInput,
} from "../db/queries.js";
import { getEmbedder } from "../embedder/index.js";
import {
  validateCaptureInput,
  validateBatchInput,
  CaptureValidationError,
  logWarnings,
  isStrictIngestEnabled,
} from "./validation.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApi(): Hono {
  const app = new Hono();
  const embedder = getEmbedder();
  const pool = getPool();

  // Middleware
  app.use("*", cors());
  app.use("*", logger());

  // Global error handler — return structured JSON for all errors
  app.onError((err, c) => {
    console.error("[api] Unhandled error:", err.message);
    return c.json(
      { error: err.message, service: "open-brain-api" },
      500
    );
  });

  // ─── Health Check ────────────────────────────────────────────────

  app.get("/health", (c) => {
    const capabilities = [
      "capture",
      "search",
      "list",
      "batch",
      "update",
      "delete",
      "stats",
      "by-source",
      "strict-validation",
      "warning-channel",
      "embed-truncation-warning",
    ];
    if (isStrictIngestEnabled()) capabilities.push("strict-ingest");
    return c.json({
      status: "healthy",
      service: "open-brain-api",
      capabilities,
    });
  });

  // ─── Capture Memory ──────────────────────────────────────────────

  app.post("/memories", async (c) => {
    let input;
    try {
      input = validateCaptureInput(await c.req.json(), { defaultSource: "api" });
    } catch (err) {
      if (err instanceof CaptureValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    try {
      const [embedding, autoMetadata] = await Promise.all([
        embedder.generateEmbedding(input.content),
        embedder.extractMetadata(input.content),
      ]);

      // Caller-supplied metadata wins over auto-extracted; both lose to `source` which
      // is canonicalised at the top level so we can index on it.
      const fullMetadata = { ...autoMetadata, ...input.metadata, source: input.source };
      const result = await insertThought(
        pool, input.content, embedding, fullMetadata, input.project, input.supersedes, input.created_by
      );

      logWarnings(input.warnings, {
        transport: "rest",
        source: input.source,
        project: input.project,
        created_by: input.created_by,
      });

      return c.json({
        id: result.id,
        type: (fullMetadata.type as string | undefined) ?? autoMetadata.type,
        topics: (fullMetadata.topics as string[] | undefined) ?? autoMetadata.topics,
        people: (fullMetadata.people as string[] | undefined) ?? autoMetadata.people,
        project: result.project,
        captured_at: result.created_at.toISOString(),
        warnings: input.warnings,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Capture failed:", message);
      return c.json(
        { error: "Failed to capture thought", detail: message },
        502
      );
    }
  });

  // ─── Batch Capture ───────────────────────────────────────────────

  app.post("/memories/batch", async (c) => {
    let batch;
    try {
      batch = validateBatchInput(await c.req.json(), { defaultSource: "api" });
    } catch (err) {
      if (err instanceof CaptureValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    try {
      const processed: BatchThoughtInput[] = await Promise.all(
        batch.items.map(async (item) => {
          const [embedding, autoMetadata] = await Promise.all([
            embedder.generateEmbedding(item.content),
            embedder.extractMetadata(item.content),
          ]);
          return {
            content: item.content,
            embedding,
            metadata: { ...autoMetadata, ...item.metadata, source: item.source },
            project: item.project,
            created_by: item.created_by,
          };
        })
      );

      const results = await batchInsertThoughts(pool, processed);

      for (const w of batch.warnings) {
        console.warn(
          `[ingest-warning] ${JSON.stringify({
            transport: "rest",
            scope: "batch-envelope",
            field: w.field,
            reason: w.reason,
            message: w.message,
          })}`,
        );
      }
      for (const item of batch.items) {
        logWarnings(item.warnings, {
          transport: "rest",
          source: item.source,
          project: item.project,
          created_by: item.created_by,
        });
      }

      return c.json({
        count: results.length,
        envelope_warnings: batch.warnings,
        results: results.map((r, i) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          project: r.project,
          captured_at: r.created_at.toISOString(),
          warnings: batch.items[i]?.warnings ?? [],
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Batch capture failed:", message);
      return c.json(
        { error: "Failed to batch capture thoughts", detail: message },
        502
      );
    }
  });

  // ─── Search Memories ─────────────────────────────────────────────

  app.post("/memories/search", async (c) => {
    const body = await c.req.json<{
      query: string;
      limit?: number;
      threshold?: number;
      project?: string;
      created_by?: string;
      type?: string;
      topic?: string;
      include_archived?: boolean;
    }>();

    if (!body.query || body.query.trim().length === 0) {
      return c.json({ error: "query is required" }, 400);
    }

    try {
      // Build JSONB filter from type/topic
      const filter: Record<string, unknown> = {};
      if (body.type) filter.type = body.type;
      if (body.topic) filter.topics = [body.topic];

      const queryEmbedding = await embedder.generateEmbedding(body.query);
      const results = await searchThoughts(
        pool,
        queryEmbedding,
        body.limit ?? 10,
        body.threshold ?? 0.5,
        filter,
        body.project,
        body.include_archived,
        body.created_by
      );

      return c.json({
        query: body.query,
        count: results.length,
        results: results.map((r) => ({
          content: r.content,
          metadata: r.metadata,
          similarity: Math.round(r.similarity * 1000) / 1000,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Search failed:", message);
      return c.json(
        { error: "Failed to search thoughts", detail: message },
        502
      );
    }
  });

  // ─── List Memories ───────────────────────────────────────────────

  app.post("/memories/list", async (c) => {
    try {
      const body = await c.req.json<ListFilters>();
      const results = await listThoughts(pool, body);

      return c.json({
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          project: r.project,
          created_by: r.created_by,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] List failed:", message);
      return c.json(
        { error: "Failed to list thoughts", detail: message },
        500
      );
    }
  });

  // ─── Update Memory ───────────────────────────────────────────────

  app.put("/memories/:id", async (c) => {
    const id = c.req.param("id");

    if (!UUID_RE.test(id)) {
      return c.json({ error: "id must be a valid UUID" }, 400);
    }

    const body = await c.req.json<{ content: string }>();

    if (!body.content || body.content.trim().length === 0) {
      return c.json({ error: "content is required" }, 400);
    }

    try {
      const [embedding, metadata] = await Promise.all([
        embedder.generateEmbedding(body.content),
        embedder.extractMetadata(body.content),
      ]);

      const result = await updateThought(pool, id, body.content, embedding, metadata);

      return c.json({
        status: "updated",
        id: result.id,
        type: metadata.type,
        topics: metadata.topics,
        content: result.content,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        return c.json({ error: message }, 404);
      }
      console.error("[api] Update failed:", message);
      return c.json(
        { error: "Failed to update thought", detail: message },
        502
      );
    }
  });

  // ─── Delete Memory ───────────────────────────────────────────────

  app.delete("/memories/:id", async (c) => {
    const id = c.req.param("id");

    if (!UUID_RE.test(id)) {
      return c.json({ error: "id must be a valid UUID" }, 400);
    }

    try {
      const result = await deleteThought(pool, id);

      if (!result.deleted) {
        return c.json({ error: `Thought not found: ${id}` }, 404);
      }

      return c.json({ status: "deleted", id: result.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Delete failed:", message);
      return c.json(
        { error: "Failed to delete thought", detail: message },
        502
      );
    }
  });

  // ─── Get Memories by Source ──────────────────────────────────────────

  app.get("/memories/by-source", async (c) => {
    const source = c.req.query("source");

    if (!source || source.trim().length === 0) {
      return c.json({ error: "source query parameter is required" }, 400);
    }

    try {
      const project = c.req.query("project");
      const created_by = c.req.query("created_by");
      const include_archived = c.req.query("include_archived") === "true";
      const limitParam = c.req.query("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;

      const results = await searchThoughtsBySource(pool, source, {
        project: project ?? undefined,
        created_by: created_by ?? undefined,
        include_archived,
        limit,
      });

      return c.json({
        source,
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          project: r.project,
          created_by: r.created_by,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] By-source lookup failed:", message);
      return c.json(
        { error: "Failed to look up memories by source", detail: message },
        500
      );
    }
  });

  // ─── Stats ───────────────────────────────────────────────────────

  app.get("/stats", async (c) => {
    try {
      const project = c.req.query("project");
      const created_by = c.req.query("created_by");
      const stats = await getThoughtStats(pool, project, created_by);
      return c.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Stats failed:", message);
      return c.json(
        { error: "Failed to get stats", detail: message },
        500
      );
    }
  });

  return app;
}
