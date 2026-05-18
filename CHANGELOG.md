# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.3] - 2026-05-18

### Changed
- Ollama embedder now surfaces the upstream response body in error messages
  (previously only `400 Bad Request` was shown), making embed failures diagnosable end-to-end.
- Ollama embed requests send `truncate: true` explicitly to prevent oversized-content failures.
- Empty-vector responses from Ollama now throw a clear `no vector for this content` error
  instead of the opaque `Ollama returned empty embedding`. Includes `content_bytes` for debugging.

## [0.7.0] - 2026-05-16

### Added
- Provenance helpers: generated columns `source_file_hash` and `code_hash` on `thoughts`,
  partial indexes (`idx_thoughts_source_file_hash`, `idx_thoughts_code_hash`), and the
  `match_thoughts_by_source(source_hash, max_count, project_filter, include_archived)` RPC
  (migration `003-add-provenance-helpers.sql`).
- REST endpoint `GET /memories/by-source` for retrieving thoughts by source/origin
  (supports `source`, `project`, `created_by`, `include_archived`, `limit`).
- `created_by` user-attribution filter across list/search endpoints.
- `metadata.provenance` sub-object (`origin`, `original_id`, `imported_at`) for imported thoughts.

### Changed
- Documentation refresh: `docs/02-DATABASE-SCHEMA.md` (Provenance helpers section),
  `docs/04-MCP-SERVER.md`, and `README.md` updated for source-based lookup surface.
- Version bumped to `0.7.0` (pre-1.0 release line).
