# AGENTS.md — Guide for AI coding agents working on Open Brain

> This file is read automatically by GitHub Copilot, Claude Code, Cursor, Aider, Devin, and other AI agents that look for `AGENTS.md` (the emerging cross-tool convention). If you're a human reader, you can safely ignore it — head to the [README](README.md) instead.

You are an AI agent helping a user with Open Brain — a persistent semantic-memory backend for AI tools, built on **Node 22 + TypeScript + PostgreSQL + pgvector**, exposing **REST** (`:8000`) and **MCP-over-SSE** (`:8080`).

---

## When the user wants to install / deploy Open Brain

There are **five canonical paths**. Pick one by interviewing the user — do not invent a sixth, do not blend two paths, and do not skip the verification step at the end.

| User says… | Use this path | Authoritative guide |
|------------|---------------|---------------------|
| "On my laptop", "locally", "Windows", "Mac", "try it out" | 🖥️ Docker Desktop dev box | [docs/11-DOCKER-DESKTOP-DEVBOX.md](docs/11-DOCKER-DESKTOP-DEVBOX.md) |
| "On my server", "NAS", "Pi", "VPS", "Linux box" | 🐳 Docker Compose | [README — Quick Start](README.md#quick-start-docker-compose) |
| "In the cloud cheaply", "always-on", "from my phone", "like Nate's setup" | ☁️ Cheap hosted (Supabase + Fly + OpenRouter) | [docs/12-HOSTED-CHEAP.md](docs/12-HOSTED-CHEAP.md) |
| "Kubernetes", "K8s", "homelab cluster" | ☸️ Kubernetes | [docs/09-SELF-HOSTED-K8S.md](docs/09-SELF-HOSTED-K8S.md) |
| "Azure", "managed cloud", "team production" | 🚀 Azure (Bicep) | [docs/10-AZURE-DEPLOYMENT.md](docs/10-AZURE-DEPLOYMENT.md) |

**Don't know which?** Use the **🤔 Help me decide** prompt from [EASY-SETUP.md](EASY-SETUP.md) — ask the user three questions (where the AI tools live, hardware vs managed, budget) and pick.

### Bootstrap procedure (the same for every path)

1. **Detect** existing state — is the repo cloned? Is `.env` present? Are containers running? Don't redo work.
2. **Verify prerequisites** for the chosen path before generating anything.
3. **Generate secrets, never reuse them.** `MCP_ACCESS_KEY` and `DB_PASSWORD` must be fresh per install. Use `openssl rand -hex 32` (Linux/Mac) or the PowerShell equivalent in `setup.ps1`. **Never** print these to chat output in full — mask after the first 8 chars when showing the user.
4. **Apply migrations in order** — `db/init.sql` first, then everything in `db/migrations/` sorted alphanumerically. Don't skip the `.down.sql` files (they're rollbacks; don't apply them on a fresh install).
5. **Match `EMBEDDING_DIMENSIONS` to the embedder**:
   - Ollama `nomic-embed-text` → **768**
   - OpenRouter / Azure OpenAI `text-embedding-3-small` → **1536**
   - Mismatched dims means `CREATE TABLE` succeeds but every capture fails with `dimension mismatch`. This is the #1 newbie footgun.
6. **End with verification**, not a "should work now". Run `scripts/verify.{ps1,sh} <api-url>` against the new deployment. If it returns non-zero, *do not* declare success.
7. **Configure exactly one AI client** at the end (ask which). Don't try to configure all nine.

### What NOT to do

- ❌ Don't invent a sixth deployment path (no "ngrok tunnel from laptop", no "AWS Lambda", no random custom shape). If the user has a weird need, point them at the closest official path and let them adapt.
- ❌ Don't suggest `docker run` ad-hoc — always use the compose files we ship.
- ❌ Don't edit `docker-compose.yml` or `Dockerfile` for a routine install. Set env vars in `.env`.
- ❌ Don't change `vector(N)` in `db/init.sql` after a table exists — it requires a destructive recreate. Only edit before first apply.
- ❌ Don't paste the user's `MCP_ACCESS_KEY` back to them in plain text. Mask it.
- ❌ Don't run integration tests (`npm run test:integration`) against an empty new install without warning — they create and delete real data. Fine on dev box, problematic if pointed at a live shared instance.

---

## When the user is debugging an existing install

1. **First, run `scripts/verify.{ps1,sh} <api-url>`**. It pinpoints which layer is broken.
2. Then consult [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for that layer.
3. Common gotchas you'll see often:
   - Ollama on host + container can't reach it → fix is `host.docker.internal` not `localhost`.
   - Multi-replica K8s + SSE drops → fix is `sessionAffinity: ClientIP`.
   - Supabase `prepared statement already exists` → fix is pooler URL (port 6543), not direct (5432).
   - Claude Desktop "MCP server failed" → almost always wrong port (`8080` for MCP, not `8000`) or key mismatch.
   - `404` on `/memories/*` from outside the cluster → REST (port 8000) is **in-cluster only** by design; the Tailscale Funnel only exposes MCP on 8080. See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#network-exposure-which-ports-go-where).
   - External MCP client reports "0 failures" but rows are missing → the client is ignoring `res.isError` on tool responses. MCP returns tool-level errors inside a 200 envelope and silently treating them as success is a known footgun. Tell the client to check `isError` and propagate the server body.

---

## When the user wants to add a feature / change code

### Repo layout

```
src/
  index.ts                Bootstraps REST + MCP servers
  api/routes.ts           REST endpoints — every MCP tool has a REST equivalent
  db/connection.ts        pg pool
  db/queries.ts           All SQL (parameterized) lives here
  embedder/               Provider-agnostic embedder interface
    types.ts              The Embedder interface
    ollama.ts             Local Ollama implementation
    openrouter.ts         OpenRouter implementation
    azure-openai.ts       Azure OpenAI implementation
    index.ts              Factory: picks one based on EMBEDDER_PROVIDER
  mcp/server.ts           MCP tool definitions
db/
  init.sql                Initial schema (vector column dim varies by deploy)
  migrations/             Applied in alphanumeric order
deploy/
  devbox/                 Docker Desktop compose (Win/Mac)
  hosted/{fly,render,railway}/    PaaS templates
  on-prem/{docker,k8s}/   Generic Linux + K8s
  azure/                  Bicep + deploy.ps1
docs/
  09-SELF-HOSTED-K8S.md   K8s walkthrough
  10-AZURE-DEPLOYMENT.md  Azure walkthrough
  11-DOCKER-DESKTOP-DEVBOX.md
  12-HOSTED-CHEAP.md
  TROUBLESHOOTING.md
src/__integration__/      Tests that hit a running API via OPENBRAIN_API_URL
src/*/__tests__/          Vitest unit tests
```

### Build & test commands

```bash
npm install
npm run build              # tsc → dist/
npm test                   # unit tests (vitest.config.ts)
OPENBRAIN_API_URL=http://localhost:8000 npm run test:integration
# integration suite is 27 tests — full CRUD + provenance + filtering
```

### Conventions

- **Strict TypeScript.** No `any` without a comment justifying it.
- **All SQL parameterized.** Never string-concatenate user input. The codebase has zero raw-SQL injection sites; keep it that way.
- **Provider abstraction.** Anything that talks to an LLM/embedder goes through `src/embedder/types.ts`. Don't sprinkle provider-specific calls elsewhere.
- **Errors at boundaries only.** Validate at HTTP/MCP entry points; internal helpers trust their inputs.
- **No new direct deps without justification.** This codebase intentionally has few dependencies. Prefer std lib + `pg` + the MCP SDK.
- **Tests live next to code** (`src/foo/__tests__/foo.test.ts`), except integration tests which live in `src/__integration__/`.

### When adding a new embedder provider

1. Add `src/embedder/<provider>.ts` implementing the `Embedder` interface.
2. Register it in `src/embedder/index.ts` factory.
3. Add env vars to `.env.example`.
4. Add unit tests.
5. Document the dimension in the README provider table and `AGENTS.md` above.

### When adding a new deployment path

Don't, unless you've talked to the maintainer. Five paths is already a lot to keep tested. Prefer extending an existing path's docs.

---

## House style for chat replies

- Be brief. The user's screen is small.
- Always show what you're about to do *before* a destructive command (`docker compose down -v`, `DROP TABLE`, `fly destroy`).
- After multi-step work, end with a one-line summary, not a long recap.
- Don't sign messages.

---

## Useful references inside this repo

- [README.md](README.md) — landing page, deployment matrix, MCP tool docs
- [EASY-SETUP.md](EASY-SETUP.md) — per-path AI prompts you can pass to other agents
- [docs/06-PROMPT-KIT.md](docs/06-PROMPT-KIT.md) — how to prompt clients to *use* Open Brain well
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — cross-cutting fixes
- [deploy/README.md](deploy/README.md) — overview of every deploy template
- [scripts/verify.{ps1,sh}](scripts/) — universal smoke test
