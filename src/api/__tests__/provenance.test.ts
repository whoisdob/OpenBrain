/**
 * Unit tests for provenance-related API features:
 *  - POST /memories validation (source, project)
 *  - /health capabilities field
 *  - GET /memories/by-source
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("../../db/connection.js", () => ({
  getPool: () => {
    const mockQuery = vi.fn();
    const mockConnect = vi.fn().mockResolvedValue({
      query: vi.fn(),
      release: vi.fn(),
    });
    return { query: mockQuery, connect: mockConnect };
  },
}));

const mockGenerateEmbedding = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
const mockExtractMetadata = vi.fn().mockResolvedValue({
  type: "observation",
  topics: ["test"],
  people: [],
  action_items: [],
  dates: [],
});

vi.mock("../../embedder/index.js", () => ({
  getEmbedder: () => ({
    generateEmbedding: mockGenerateEmbedding,
    extractMetadata: mockExtractMetadata,
  }),
}));

// Mock query functions
const mockInsertThought = vi.fn();
const mockSearchThoughts = vi.fn();
const mockListThoughts = vi.fn();
const mockGetThoughtStats = vi.fn();
const mockUpdateThought = vi.fn();
const mockDeleteThought = vi.fn();
const mockBatchInsertThoughts = vi.fn();
const mockSearchThoughtsBySource = vi.fn();

vi.mock("../../db/queries.js", () => ({
  insertThought: (...args: any[]) => mockInsertThought(...args),
  searchThoughts: (...args: any[]) => mockSearchThoughts(...args),
  listThoughts: (...args: any[]) => mockListThoughts(...args),
  getThoughtStats: (...args: any[]) => mockGetThoughtStats(...args),
  updateThought: (...args: any[]) => mockUpdateThought(...args),
  deleteThought: (...args: any[]) => mockDeleteThought(...args),
  batchInsertThoughts: (...args: any[]) => mockBatchInsertThoughts(...args),
  searchThoughtsBySource: (...args: any[]) => mockSearchThoughtsBySource(...args),
}));

import { createApi } from "../routes.js";

describe("Provenance API Features", () => {
  const app = createApi();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── /health capabilities ────────────────────────────────────────

  describe("GET /health capabilities", () => {
    it("returns a capabilities array", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; capabilities: string[] };
      expect(body.status).toBe("healthy");
      expect(Array.isArray(body.capabilities)).toBe(true);
      expect(body.capabilities.length).toBeGreaterThan(0);
    });

    it("capabilities include by-source", async () => {
      const res = await app.request("/health");
      const body = (await res.json()) as { capabilities: string[] };
      expect(body.capabilities).toContain("by-source");
    });

    it("capabilities include core features", async () => {
      const res = await app.request("/health");
      const body = (await res.json()) as { capabilities: string[] };
      expect(body.capabilities).toContain("capture");
      expect(body.capabilities).toContain("search");
      expect(body.capabilities).toContain("list");
      expect(body.capabilities).toContain("stats");
    });
  });

  // ─── POST /memories validation ───────────────────────────────────

  describe("POST /memories validation", () => {
    it("returns 400 for empty source string", async () => {
      const res = await app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "valid content", source: "" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/source/i);
    });

    it("returns 400 for whitespace-only source", async () => {
      const res = await app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "valid content", source: "   " }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for empty project string", async () => {
      const res = await app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "valid content", project: "" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/project/i);
    });

    it("returns 400 for whitespace-only project", async () => {
      const res = await app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "valid content", project: "  " }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts valid source and project", async () => {
      mockInsertThought.mockResolvedValueOnce({
        id: "abc-123",
        content: "test",
        metadata: { type: "observation" },
        project: "my-proj",
        created_at: new Date(),
      });

      const res = await app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "valid content",
          source: "cli",
          project: "my-proj",
        }),
      });
      expect(res.status).toBe(200);
    });

    it("allows omitting source and project", async () => {
      mockInsertThought.mockResolvedValueOnce({
        id: "abc-456",
        content: "test",
        metadata: { type: "observation" },
        project: null,
        created_at: new Date(),
      });

      const res = await app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "valid content" }),
      });
      expect(res.status).toBe(200);
    });
  });

  // ─── GET /memories/by-source ─────────────────────────────────────

  describe("GET /memories/by-source", () => {
    it("returns 400 when source param is missing", async () => {
      const res = await app.request("/memories/by-source");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/source/i);
    });

    it("returns 400 when source is empty", async () => {
      const res = await app.request("/memories/by-source?source=");
      expect(res.status).toBe(400);
    });

    it("returns results for valid source", async () => {
      mockSearchThoughtsBySource.mockResolvedValueOnce([
        {
          id: "id-1",
          content: "memory from cli",
          metadata: { source: "cli" },
          project: "proj",
          created_by: "user1",
          created_at: new Date("2025-01-01"),
        },
      ]);

      const res = await app.request("/memories/by-source?source=cli");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { source: string; count: number; results: any[] };
      expect(body.source).toBe("cli");
      expect(body.count).toBe(1);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].id).toBe("id-1");
    });

    it("passes project and created_by to query function", async () => {
      mockSearchThoughtsBySource.mockResolvedValueOnce([]);

      const res = await app.request(
        "/memories/by-source?source=api&project=my-proj&created_by=user1"
      );
      expect(res.status).toBe(200);

      expect(mockSearchThoughtsBySource).toHaveBeenCalledTimes(1);
      const callArgs = mockSearchThoughtsBySource.mock.calls[0]!;
      expect(callArgs[1]).toBe("api");
      expect(callArgs[2]).toMatchObject({
        project: "my-proj",
        created_by: "user1",
      });
    });

    it("passes include_archived and limit options", async () => {
      mockSearchThoughtsBySource.mockResolvedValueOnce([]);

      const res = await app.request(
        "/memories/by-source?source=api&include_archived=true&limit=5"
      );
      expect(res.status).toBe(200);

      const callArgs = mockSearchThoughtsBySource.mock.calls[0]!;
      expect(callArgs[2]).toMatchObject({
        include_archived: true,
        limit: 5,
      });
    });

    it("returns empty array when no matches", async () => {
      mockSearchThoughtsBySource.mockResolvedValueOnce([]);

      const res = await app.request("/memories/by-source?source=nonexistent");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number; results: any[] };
      expect(body.count).toBe(0);
      expect(body.results).toHaveLength(0);
    });

    it("returns 500 on internal error", async () => {
      mockSearchThoughtsBySource.mockRejectedValueOnce(new Error("db connection failed"));

      const res = await app.request("/memories/by-source?source=cli");
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBeTruthy();
    });
  });
});
