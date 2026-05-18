# Open Brain — Troubleshooting

Cross-cutting fixes for problems that hit *any* deployment path. For path-specific issues, see the troubleshooting section inside each deployment guide.

---

## Decision tree

```
Something's broken
  │
  ├─ Does scripts/verify.sh <api-url> pass?
  │    yes → problem is in the AI client, not the server → "Client config" section below
  │    no  → continue
  │
  ├─ Which check failed?
  │    REST /health    → "API container won't start" section
  │    Capture         → "Capture fails / embeddings" section
  │    Search          → "Search returns nothing" section
  │
  └─ Still stuck? Open an issue with `scripts/verify.sh` output attached.
```

Run the universal verify script before anything else:

```bash
./scripts/verify.sh <your-api-url>    # Linux/macOS
.\scripts\verify.ps1 <your-api-url>   # Windows
```

---

## API container won't start

### Symptom: `docker compose up` exits immediately or health stays unhealthy

Check the logs first:

```bash
docker compose logs --tail=50 api
```

| Error you see | Cause | Fix |
|---------------|-------|-----|
| `getaddrinfo ENOTFOUND postgres` | API started before Postgres | Wait — the compose `depends_on: condition: service_healthy` should handle this. If it persists, `docker compose down && docker compose up -d`. |
| `ECONNREFUSED 127.0.0.1:11434` | Ollama unreachable from inside container | Change `OLLAMA_ENDPOINT` in `.env` from `localhost` to `host.docker.internal` (Win/Mac) or your host's LAN IP (Linux). |
| `password authentication failed for user "openbrain"` | DB password mismatch between `.env` and the volume | Either fix `.env` to match the original password, or wipe the volume: `docker compose down -v && docker compose up -d` (**deletes all thoughts**). |
| `ERROR: type "vector" does not exist` | pgvector extension not installed | You're using a base `postgres:17` image. Switch to `pgvector/pgvector:pg17` (already the default in our compose files). |
| `EADDRINUSE :::8000` | Port already in use on host | Stop the conflicting process (`lsof -i :8000` on Mac/Linux, `Get-NetTCPConnection -LocalPort 8000` on Windows) **or** change `API_PORT` in `.env`. |
| `Error: Cannot find module 'dist/index.js'` | Built image is stale | `docker compose build --no-cache api && docker compose up -d`. |

### Symptom: `/health` returns 200 but everything else 500s

Almost always a database initialization problem.

```bash
docker exec -it openbrain-postgres psql -U openbrain -d openbrain -c '\dt'
```

You should see the `thoughts` table. If not:

```bash
docker exec -i openbrain-postgres psql -U openbrain -d openbrain < db/init.sql
docker exec -i openbrain-postgres psql -U openbrain -d openbrain < db/migrations/001-dev-ready-upgrade.sql
# …repeat for each migration in order
```

For Supabase / Neon / Azure PG, paste those files into your provider's SQL editor.

---

## Capture fails / embeddings problems

### Symptom: `POST /memories` hangs or times out

The embedder isn't responding. Identify which one you're using:

```bash
docker exec openbrain-api env | grep EMBEDDER_PROVIDER
```

#### `EMBEDDER_PROVIDER=ollama`

```bash
# From your host:
curl http://localhost:11434/api/tags

# From inside the API container:
docker exec openbrain-api wget -qO- http://host.docker.internal:11434/api/tags
```

If the second one fails:

- **Mac/Windows Docker Desktop**: confirm `OLLAMA_ENDPOINT=http://host.docker.internal:11434` in `.env`.
- **Linux Docker**: `host.docker.internal` isn't defined by default. Use your host's LAN IP, or add to the API service in `docker-compose.yml`:
  ```yaml
  extra_hosts:
    - "host.docker.internal:host-gateway"
  ```
- **K8s**: Ollama needs to be reachable from the pod. Either run Ollama as a sidecar/Deployment, or use a `Service` of `type: ExternalName` pointing to your LAN.

Also confirm the models are pulled:

```bash
ollama list
# nomic-embed-text  must be present (or whatever OLLAMA_EMBED_MODEL says)
# llama3.2          must be present (or whatever OLLAMA_LLM_MODEL says)
```

#### `EMBEDDER_PROVIDER=openrouter`

```bash
curl https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" | head
```

- 401 → bad API key
- 429 → rate-limited, wait or upgrade plan
- 200 but `OPENROUTER_EMBED_MODEL` not in the list → model name typo

#### `EMBEDDER_PROVIDER=azure-openai`

```bash
curl "$AZURE_OPENAI_ENDPOINT/openai/deployments?api-version=$AZURE_OPENAI_API_VERSION" \
  -H "api-key: $AZURE_OPENAI_KEY"
```

- 401 → bad key
- 404 → wrong endpoint URL (must end with `.openai.azure.com`, no trailing slash)
- Empty list → deployments not created — go to **Azure AI Studio → Deployments**.

### Symptom: `dimension mismatch: vector(768) vs vector(1536)`

The embedder produces a different-sized vector than the column accepts. **Dimensions cannot change after data exists** — you have to recreate the table.

```sql
-- BACK UP FIRST. This deletes all thoughts.
DROP TABLE thoughts CASCADE;
-- Then re-run db/init.sql with the correct vector(N).
```

Reference:
- Ollama `nomic-embed-text` → **768**
- OpenAI / Azure OpenAI `text-embedding-3-small` → **1536**
- OpenAI / Azure OpenAI `text-embedding-3-large` → **3072**

Also set `EMBEDDING_DIMENSIONS` env var to match.

---

## Search returns nothing

### Symptom: capture works, but `search_thoughts` always returns `[]`

1. **Confirm thoughts exist:**
   ```bash
   curl <api-url>/memories | jq 'length'
   ```
   If 0, your captures aren't actually persisting — see "Capture fails" above.

2. **Confirm embeddings are stored:**
   ```sql
   SELECT id, content, (embedding IS NULL) AS missing_embedding FROM thoughts LIMIT 5;
   ```
   If `missing_embedding = true`, the embedder silently returned an error. Check API logs.

3. **Lower the threshold:**
   The default `threshold` is 0.5. Try 0.0 to see if it's just a high cutoff:
   ```bash
   curl -X POST <api-url>/memories/search \
     -H "Content-Type: application/json" \
     -d '{"query":"anything", "threshold":0.0, "limit":10}'
   ```

4. **Mismatched embedder between capture & search?**
   If you changed `EMBEDDER_PROVIDER` after capturing some thoughts, old embeddings live in a different space — they'll never match new queries. Re-embed (re-capture) those thoughts, or set up a migration script.

---

## Client config issues

### VS Code Copilot doesn't show OpenBrain tools

1. Check `.vscode/mcp.json` exists and has the right URL.
2. Reload VS Code (`Ctrl+Shift+P → Developer: Reload Window`).
3. In Copilot Chat, switch to **Agent** mode (not Ask).
4. View MCP server status: `Ctrl+Shift+P → MCP: List Servers` — green dot = connected.
5. If red, expand for the error — usually wrong URL or `key=` mismatch.

### Claude Desktop says "MCP server failed to start"

Almost always `mcp-remote` can't reach your URL.

```bash
# From a regular terminal, run the same command Claude Desktop would:
npx -y mcp-remote http://localhost:8080/sse?key=YOUR_KEY
```

Should connect and print SSE events. If it errors:
- Wrong port (use `8080` for MCP, not `8000` for REST)
- Wrong key (must match `MCP_ACCESS_KEY` in your `.env` exactly)
- For hosted: missing `https://`

**Tip:** Claude Desktop overwrites `claude_desktop_config.json` on every launch. Edit the file **while Claude is closed**, save, then start Claude.

### `mcp-remote` keeps disconnecting

The SSE connection drops after 30–60 sec on some networks (corporate proxies, certain VPNs). Workarounds:
- Use a direct TCP transport instead of SSE: not yet supported in Open Brain
- Bypass the proxy for your MCP URL
- Switch to a hosted deployment with TLS — most proxies are friendlier to HTTPS

### Multi-replica deployment: SSE works once, then "session not found"

You have 2+ replicas without session affinity. The SSE *connect* hit one pod; the follow-up POST hit a different pod that doesn't know the session.

**K8s fix** — add to your Service:
```yaml
sessionAffinity: ClientIP
sessionAffinityConfig:
  clientIP:
    timeoutSeconds: 10800
```

**Azure Container Apps fix** — enable session affinity in the ingress config (`affinity: sticky`).

---

## Azure-specific

### `deploy.ps1` fails with `Cannot find name 'psql'`

Install the Postgres client:
- Windows: `choco install postgresql` (or just the client: `winget install PostgreSQL.PostgreSQL`)
- macOS: `brew install libpq && brew link --force libpq`
- Linux: `apt install postgresql-client` / `dnf install postgresql`

### `deploy.ps1` succeeds but the API is unhealthy

Check Container Apps logs:
```powershell
az containerapp logs show -n openbrain-api -g <rg> --tail 100
```

Common causes:
- Database firewall blocking Container Apps egress — the Bicep adds the rule `AllowAllAzureServices`; confirm it's still there.
- Container image pull failed — check **Container Apps → Revisions → failed revision → log**.

---

## Hosted (Fly / Render / Railway) -specific

### Fly: `Error: machine is in a state that does not support deploy` 

The machine is stopped/suspended. Either:
```bash
fly machine start
fly deploy
```

### Render free tier: first request after idle takes 30+ seconds

That's the **free-tier cold start** — fix by upgrading to Starter (~$7/mo) or switching to Fly's suspend mode (~1 sec wake).

### Supabase: `error: prepared statement "s0" already exists`

You're using the **direct** connection (port 5432) when Supabase wants you on the **pooler** (port 6543) for transaction mode. Get the pooled connection string from **Settings → Database → Connection pooling**.

---

## Network exposure (which ports go where)

Open Brain listens on **two ports**:

| Port | Protocol | Auth | Intended scope |
|---|---|---|---|
| `8000` | REST (`/health`, `/memories/*`, `/stats`) | None — assumes in-cluster / internal | In-cluster or trusted-network only |
| `8080` | MCP-over-SSE (`/sse`, `/messages`) | `MCP_ACCESS_KEY` via `x-brain-key` header or `?key=` query | Safe to expose publicly |

### Self-hosted K8s + Tailscale Funnel: REST is in-cluster only

The K8s manifest in `deploy/on-prem/k8s/` ships a single Tailscale Funnel that forwards to **port 8080** (MCP). This is deliberate — REST has no auth, so we do not expose it publicly. Symptoms of mis-assuming REST is reachable:

- `POST <funnel-host>/memories` → `404 Not Found`
- `POST <funnel-host>/memories/batch` → `404 Not Found`
- `GET <funnel-host>/health` → returns the **MCP** health payload (`service: "open-brain-mcp"`), not the REST one

External tooling that wants high-throughput bulk capture has two correct paths:

1. **Use MCP-over-SSE** with `capture_thoughts` (batch). Make sure the client honours `res.isError` on tool responses — MCP can return tool-level errors with a 200 envelope, and silently treating them as success was the root cause of the 2026-05-18 Plan-Forge "0 failures / 20 records lost" incident.
2. **Run the tool inside the cluster** (e.g. a Job or `kubectl run` pod) and call REST on `openbrain-api.openbrain.svc.cluster.local:8000` directly.

Do **not** add a second Funnel for port 8000 without first putting auth in front of the REST API. The deployment assumes REST is internal-only.

---

## Still stuck?

1. Run `scripts/verify.{ps1,sh}` and save the output.
2. Get the last 50 lines of API logs:
   ```bash
   docker compose logs --tail=50 api > api.log     # Docker
   kubectl logs -n openbrain deploy/openbrain-api --tail=50 > api.log    # K8s
   fly logs --no-tail > api.log                    # Fly
   az containerapp logs show -n openbrain-api -g <rg> --tail 50 > api.log  # Azure
   ```
3. Open an issue: <https://github.com/srnichols/OpenBrain/issues/new>
   - Include: deployment path, verify output, last 50 log lines, redacted `.env` (no keys).
