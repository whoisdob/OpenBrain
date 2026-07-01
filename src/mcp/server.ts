/**
 * MCP Server for Open Brain.
 * Exposes seven tools: search_thoughts, list_thoughts, capture_thought, thought_stats,
 * update_thought, delete_thought, capture_thoughts (batch).
 *
 * Uses the official @modelcontextprotocol/sdk TypeScript SDK.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getPool } from "../db/connection.js";
import {
  insertThought,
  searchThoughts,
  listThoughts,
  getThoughtStats,
  updateThought,
  deleteThought,
  batchInsertThoughts,
  type ListFilters,
  type BatchThoughtInput,
  type SearchResult,
  type ThoughtRow,
} from "../db/queries.js";
import { getEmbedder } from "../embedder/index.js";
import {
  validateCaptureInput,
  validateBatchInput,
  CaptureValidationError,
  formatWarnings,
  logWarnings,
} from "../api/validation.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// lsje39 / D-103 (docs/26 §3, §7): a per-agent caller identity, resolved from the
// presented MCP key in index.ts and threaded into createMcpServer(). `read_scope`
// is the list of `created_by` namespaces this agent may read (and write), sourced
// from user_config (the seed in scripts/read-scope.py).
export type AgentIdentity = { agent: string; read_scope: string[] };

// lsje39 / D-103 read-scope filter. Two phases, chosen by SCOPE_ENFORCE:
//   unset (SHADOW, docs/26 §7 step 2): observe-only, logs verdict, blocks NOTHING.
//   "1"  (ENFORCE, step 3): reads are actually narrowed/rejected server-side.
// Read and write target sets coincide in the F&F model (own ∪ circles == read_scope).
const SCOPE_ENFORCE = process.env.SCOPE_ENFORCE === "1";

function shadowScope(
  identity: AgentIdentity | undefined,
  tool: string,
  createdBy: string | undefined,
  kind: "read" | "write"
): void {
  if (!identity) return; // unscoped/legacy caller — nothing to attribute
  const scope = identity.read_scope;
  const inScope = createdBy !== undefined && scope.includes(createdBy);
  const mode = SCOPE_ENFORCE ? "enforce" : "shadow";
  // In enforce mode an out-of-scope read is narrowed (unset) or rejected (explicit),
  // so the verdict reflects what actually happened; in shadow it is hypothetical.
  const verdict = inScope
    ? "allow"
    : SCOPE_ENFORCE
      ? createdBy === undefined
        ? "narrowed"
        : "REJECTED"
      : "WOULD-RESTRICT";
  console.log(
    `[scope-shadow] mode=${mode} agent=${identity.agent} kind=${kind} tool=${tool} ` +
      `created_by=${createdBy ?? "(unset/all)"} scope=[${scope.join(",")}] verdict=${verdict}`
  );
}

// Resolve a read to the namespace(s) actually queried (D-103 / docs/26 §7 step 3):
//   reject         → an explicit created_by OUTSIDE scope: return empty, no query.
//   namespaces=undefined → no enforcement (shadow/legacy/no-identity): query as-requested.
//   namespaces=[x]       → a single in-scope value: query that one.
//   namespaces=[…scope]  → an UNSET read: union across the whole read_scope (narrow, don't reject),
//                          so legitimate unscoped reads (e.g. the briefing's list) keep working.
function enforceRead(
  identity: AgentIdentity | undefined,
  requested: string | undefined
): { reject: boolean; namespaces: string[] | undefined } {
  if (!SCOPE_ENFORCE || !identity) {
    return { reject: false, namespaces: requested === undefined ? undefined : [requested] };
  }
  const scope = identity.read_scope;
  if (requested === undefined) return { reject: false, namespaces: scope };
  if (scope.includes(requested)) return { reject: false, namespaces: [requested] };
  return { reject: true, namespaces: undefined };
}

function emptyReadResult(count = 0) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ count, results: [] }, null, 2) },
    ],
  };
}

export function createMcpServer(identity?: AgentIdentity): Server {
  const server = new Server(
    { name: "open-brain", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  const embedder = getEmbedder();
  const pool = getPool();

  // ─── List Tools ──────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_thoughts",
        description:
          "Search your brain for thoughts semantically related to a query. Returns results ranked by similarity score. Supports project scoping and metadata filters.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Natural language search query",
            },
            limit: {
              type: "integer",
              description: "Maximum results to return (default: 10)",
              default: 10,
            },
            threshold: {
              type: "number",
              description: "Minimum similarity score 0-1 (default: 0.3)",
              default: 0.3,
            },
            project: {
              type: "string",
              description: "Scope search to a specific project",
            },
            type: {
              type: "string",
              description:
                "Filter by thought type: observation, task, idea, reference, person_note, decision, meeting, architecture, pattern, postmortem, requirement, bug, convention",
            },
            topic: {
              type: "string",
              description: "Filter by topic tag",
            },
            include_archived: {
              type: "boolean",
              description: "Include archived thoughts (default: false)",
              default: false,
            },
            created_by: {
              type: "string",
              description: "Filter results to thoughts created by a specific user",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "list_thoughts",
        description:
          "List thoughts filtered by type, topic, person mentioned, project, or time range.",
        inputSchema: {
          type: "object" as const,
          properties: {
            type: {
              type: "string",
              description:
                "Filter by thought type: observation, task, idea, reference, person_note, decision, meeting, architecture, pattern, postmortem, requirement, bug, convention",
            },
            topic: {
              type: "string",
              description: "Filter by topic tag",
            },
            person: {
              type: "string",
              description: "Filter by person mentioned",
            },
            days: {
              type: "integer",
              description: "Only return thoughts from the last N days",
            },
            project: {
              type: "string",
              description: "Scope to a specific project",
            },
            include_archived: {
              type: "boolean",
              description: "Include archived thoughts (default: false)",
              default: false,
            },
            created_by: {
              type: "string",
              description: "Filter results to thoughts created by a specific user",
            },
          },
        },
      },
      {
        name: "capture_thought",
        description:
          "Save a new thought to your brain. Automatically generates embedding and extracts metadata (type, topics, people, action items). Supports project scoping and provenance tracking.",
        inputSchema: {
          type: "object" as const,
          properties: {
            content: {
              type: "string",
              description: "The thought to capture (raw text)",
            },
            project: {
              type: "string",
              description: "Scope this thought to a project/workspace",
            },
            source: {
              type: "string",
              description: "Provenance tracking — where this thought came from (default: 'mcp')",
            },
            supersedes: {
              type: "string",
              description: "UUID of a prior thought this one replaces",
            },
            created_by: {
              type: "string",
              description: "Namespace owner. Required. Values: 'dan' (Dan's private context), 'family' (shared household — visible to all agents), 'nicole' (Nicole's private context). Never omit.",
            },
          },
          required: ["content", "created_by"],
        },
      },
      {
        name: "thought_stats",
        description:
          "Get statistics about your brain: total thoughts, type distribution, top topics, and top people mentioned. Optionally scoped to a project or user.",
        inputSchema: {
          type: "object" as const,
          properties: {
            project: {
              type: "string",
              description: "Scope stats to a specific project",
            },
            created_by: {
              type: "string",
              description: "Scope stats to a specific user",
            },
          },
        },
      },
      {
        name: "update_thought",
        description:
          "Update an existing thought's content. Re-generates embedding and re-extracts metadata automatically.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "UUID of the thought to update",
            },
            content: {
              type: "string",
              description: "New content for the thought",
            },
          },
          required: ["id", "content"],
        },
      },
      {
        name: "delete_thought",
        description:
          "Permanently delete a thought by ID. Deleted thoughts no longer appear in search or list results.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "UUID of the thought to delete",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "capture_thoughts",
        description:
          "Batch capture multiple thoughts in one call. Each thought gets independent embedding and metadata extraction. All share the same project and source.",
        inputSchema: {
          type: "object" as const,
          properties: {
            thoughts: {
              type: "array",
              description: "Array of thoughts to capture",
              items: {
                type: "object",
                properties: {
                  content: {
                    type: "string",
                    description: "The thought content (raw text)",
                  },
                },
                required: ["content"],
              },
            },
            project: {
              type: "string",
              description: "Scope all thoughts to a project/workspace",
            },
            source: {
              type: "string",
              description: "Provenance tracking (default: 'mcp')",
            },
            created_by: {
              type: "string",
              description: "Namespace owner. Required. Values: 'dan' (Dan's private context), 'family' (shared household — visible to all agents), 'nicole' (Nicole's private context). Never omit.",
            },
          },
          required: ["thoughts", "created_by"],
        },
      },
    ],
  }));

  // ─── Call Tool ───────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // ── search_thoughts ──
        case "search_thoughts": {
          const query = args?.query as string;
          const limit = (args?.limit as number) ?? 10;
          const threshold = (args?.threshold as number) ?? 0.3;
          const project = args?.project as string | undefined;
          const type = args?.type as string | undefined;
          const topic = args?.topic as string | undefined;
          const include_archived = (args?.include_archived as boolean) ?? false;
          const created_by = args?.created_by as string | undefined;
          shadowScope(identity, "search_thoughts", created_by, "read");

          const gate = enforceRead(identity, created_by);
          if (gate.reject) return emptyReadResult();

          // Build JSONB filter from type/topic
          const filter: Record<string, unknown> = {};
          if (type) filter.type = type;
          if (topic) filter.topics = [topic];

          const queryEmbedding = await embedder.generateEmbedding(query);
          const search = (cb: string | undefined) =>
            searchThoughts(pool, queryEmbedding, limit, threshold, filter, project, include_archived, cb);

          let results: SearchResult[];
          if (gate.namespaces === undefined || gate.namespaces.length === 1) {
            // unconstrained (shadow/legacy) or a single in-scope namespace
            results = await search(gate.namespaces ? gate.namespaces[0] : created_by);
          } else {
            // UNSET read under enforcement → union across read_scope, re-ranked by similarity
            const merged = new Map<string, SearchResult>();
            for (const ns of gate.namespaces) {
              for (const r of await search(ns)) merged.set(r.id, r);
            }
            results = [...merged.values()]
              .sort((a, b) => b.similarity - a.similarity)
              .slice(0, limit);
          }

          const formatted = results.map((r) => ({
            content: r.content,
            metadata: r.metadata,
            similarity: Math.round(r.similarity * 1000) / 1000,
            created_at: r.created_at.toISOString(),
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ count: formatted.length, results: formatted }, null, 2),
              },
            ],
          };
        }

        // ── list_thoughts ──
        case "list_thoughts": {
          const filters: ListFilters = {
            type: args?.type as string | undefined,
            topic: args?.topic as string | undefined,
            person: args?.person as string | undefined,
            days: args?.days as number | undefined,
            project: args?.project as string | undefined,
            created_by: args?.created_by as string | undefined,
            include_archived: (args?.include_archived as boolean) ?? false,
          };
          shadowScope(identity, "list_thoughts", filters.created_by, "read");

          const listGate = enforceRead(identity, filters.created_by);
          if (listGate.reject) return emptyReadResult();

          let results: ThoughtRow[];
          if (listGate.namespaces === undefined || listGate.namespaces.length === 1) {
            results = await listThoughts(
              pool,
              listGate.namespaces ? { ...filters, created_by: listGate.namespaces[0] } : filters
            );
          } else {
            // UNSET read under enforcement → union across read_scope, re-sorted by recency
            const merged = new Map<string, ThoughtRow>();
            for (const ns of listGate.namespaces) {
              for (const r of await listThoughts(pool, { ...filters, created_by: ns })) {
                merged.set(r.id, r);
              }
            }
            results = [...merged.values()]
              .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
              .slice(0, 50);
          }

          const formatted = results.map((r) => ({
            id: r.id,
            content: r.content,
            metadata: r.metadata,
            created_at: r.created_at.toISOString(),
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ count: formatted.length, results: formatted }, null, 2),
              },
            ],
          };
        }

        // ── capture_thought ──
        case "capture_thought": {
          let input;
          try {
            input = validateCaptureInput(args ?? {}, { defaultSource: "mcp" });
          } catch (err) {
            if (err instanceof CaptureValidationError) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err.message}` }],
                isError: true,
              };
            }
            throw err;
          }

          shadowScope(identity, "capture_thought", input.created_by, "write");

          // Generate embedding and extract metadata in parallel
          const [embedding, autoMetadata] = await Promise.all([
            embedder.generateEmbedding(input.content),
            embedder.extractMetadata(input.content),
          ]);

          const fullMetadata = { ...autoMetadata, ...input.metadata, source: input.source };
          const result = await insertThought(
            pool, input.content, embedding, fullMetadata, input.project, input.supersedes, input.created_by
          );

          logWarnings(input.warnings, {
            transport: "mcp",
            source: input.source,
            project: input.project,
            created_by: input.created_by,
          });

          const captureContent: { type: "text"; text: string }[] = [];
          if (input.warnings.length > 0) {
            captureContent.push({ type: "text" as const, text: formatWarnings(input.warnings) });
          }
          captureContent.push({
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "captured",
                id: result.id,
                type: (fullMetadata.type as string | undefined) ?? autoMetadata.type,
                topics: (fullMetadata.topics as string[] | undefined) ?? autoMetadata.topics,
                people: (fullMetadata.people as string[] | undefined) ?? autoMetadata.people,
                action_items: autoMetadata.action_items,
                captured_at: result.created_at.toISOString(),
                warnings: input.warnings,
              },
              null,
              2
            ),
          });

          return { content: captureContent };
        }

        // ── thought_stats ──
        case "thought_stats": {
          const project = args?.project as string | undefined;
          const created_by = args?.created_by as string | undefined;
          shadowScope(identity, "thought_stats", created_by, "read");
          const stats = await getThoughtStats(pool, project, created_by);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(stats, null, 2),
              },
            ],
          };
        }

        // ── update_thought ──
        case "update_thought": {
          const id = args?.id as string;
          const content = args?.content as string;

          if (!UUID_RE.test(id)) {
            return {
              content: [{ type: "text" as const, text: "Error: id must be a valid UUID" }],
              isError: true,
            };
          }

          // Re-generate embedding and re-extract metadata
          const [embedding, metadata] = await Promise.all([
            embedder.generateEmbedding(content),
            embedder.extractMetadata(content),
          ]);

          const result = await updateThought(pool, id, content, embedding, metadata);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "updated",
                    id: result.id,
                    type: metadata.type,
                    topics: metadata.topics,
                    updated_at: result.created_at.toISOString(),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // ── delete_thought ──
        case "delete_thought": {
          const id = args?.id as string;

          if (!UUID_RE.test(id)) {
            return {
              content: [{ type: "text" as const, text: "Error: id must be a valid UUID" }],
              isError: true,
            };
          }

          const result = await deleteThought(pool, id);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        // ── capture_thoughts (batch) ──
        case "capture_thoughts": {
          let batch;
          try {
            batch = validateBatchInput(args ?? {}, { defaultSource: "mcp" });
          } catch (err) {
            if (err instanceof CaptureValidationError) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err.message}` }],
                isError: true,
              };
            }
            throw err;
          }

          for (const it of batch.items) {
            shadowScope(identity, "capture_thoughts", it.created_by, "write");
          }

          // Process each item: embed + extract metadata + merge with caller metadata
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
                transport: "mcp",
                scope: "batch-envelope",
                field: w.field,
                reason: w.reason,
                message: w.message,
              })}`,
            );
          }
          for (const item of batch.items) {
            logWarnings(item.warnings, {
              transport: "mcp",
              source: item.source,
              project: item.project,
              created_by: item.created_by,
            });
          }

          const formatted = results.map((r, i) => ({
            id: r.id,
            content: r.content,
            metadata: r.metadata,
            captured_at: r.created_at.toISOString(),
            warnings: batch.items[i]?.warnings ?? [],
          }));

          const totalItemWarnings = formatted.reduce((n, f) => n + f.warnings.length, 0);
          const batchContent: { type: "text"; text: string }[] = [];
          if (batch.warnings.length > 0 || totalItemWarnings > 0) {
            const lines: string[] = [];
            if (batch.warnings.length > 0) {
              lines.push(formatWarnings(batch.warnings).replace(/^\u26a0\ufe0f.*\n/, "\u26a0\ufe0f Batch envelope:\n"));
            }
            formatted.forEach((f, i) => {
              if (f.warnings.length > 0) {
                lines.push(`\u26a0\ufe0f thoughts[${i}]:\n${formatWarnings(f.warnings).split("\n").slice(1).join("\n")}`);
              }
            });
            batchContent.push({ type: "text" as const, text: lines.join("\n\n") });
          }
          batchContent.push({
            type: "text" as const,
            text: JSON.stringify(
              {
                count: formatted.length,
                envelope_warnings: batch.warnings,
                results: formatted,
              },
              null,
              2
            ),
          });

          return { content: batchContent };
        }

        default:
          return {
            content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[mcp] Tool "${name}" failed:`, message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Start the MCP server on stdio transport.
 * Used when running as a standalone MCP process (e.g., `npx open-brain-mcp`).
 */
export async function startMcpStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] Server running on stdio transport");
}
