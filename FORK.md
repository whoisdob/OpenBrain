# FORK.md — this OpenBrain is a maintained fork

This clone of [srnichols/OpenBrain](https://github.com/srnichols/OpenBrain) runs
in production for **OpenAssistant** on the `oa-app` VM (`~/OpenBrain`,
`docker compose build: .`). It carries local commits that upstream does not
have. Treat it as a fork with stewardship duties, not a vendored dependency —
OpenAssistant `docs/03` ADR-008 records this as an architectural fact.

**Off-box durability (s67):** the fork is mirrored at
**github.com/whoisdob/OpenBrain** (`github` remote on this clone). `origin`
stays upstream (no push rights). The VM holds no GitHub credential — push via
the **Mac relay** (Dan's SSH key lives there):

```bash
# from the Mac, after committing here on the VM:
git clone dobrien@100.114.150.46:OpenBrain /tmp/ob-relay
git -C /tmp/ob-relay push git@github.com:whoisdob/OpenBrain.git master
rm -rf /tmp/ob-relay
```

Push after every session that commits here. If you sync from upstream, read
the whole file first.

## Why it is forked

Server-side **scope enforcement** (OpenAssistant decisions **D-103** reads,
**D-112** writes/stats; design in `docs/26`): each MCP caller presents a
per-agent key, mapped to an agent id, whose `read_scope` (list of `created_by`
namespaces) is resolved live from the `user_config` table. The MCP tool
handlers narrow/reject reads and reject out-of-scope writes **in the server**,
so no model can widen its own data access. Upstream has no concept of caller
identity beyond a single shared access key.

## Local delta inventory

| Commit | What | Why |
|---|---|---|
| `6db9031` | Shadow read-filter: per-agent key → identity, `[scope-shadow]` logging | D-103 step 2 (observe before enforce) |
| `5a9e761` | `SCOPE_ENFORCE=1` enforces reads: unset → narrowed to scope; explicit out-of-scope → rejected | D-103 step 3 |
| `0b72bee` | `SCOPE_ENFORCE_WRITES=1` enforces writes (capture/update/delete on the **target row's** `created_by`) + `thought_stats` | D-112 |
| `b65b672` | Host ports (5432/8000/8080) bound `127.0.0.1`; `docker-compose.override.yml` joins `oa-net` | nothing off-box reaches DB/REST/MCP directly; gateway reaches api by container name |
| `12b043b` | REST captures **require + whitelist** `created_by` | reject unattributed writes at the REST edge too |
| `22843da` | REST search default threshold 0.5 → 0.3 | 0.5 dropped legitimate recall matches |
| (s67) | `scope.test.ts` + export seam; `MCP_ACCESS_KEY_DESKTOP` → `dan-desktop` | regression net; 2nd MCP client (ADR-008 validation) |

### Known landmine: the hardcoded namespace whitelist

`src/api/validation.ts` `VALID_NAMESPACES = [dan, family, nicole, system-cron,
gift-radar-cron]` is **hardcoded**. Onboarding a new person (e.g. `aiden`)
requires extending this list (and rebuilding) until it derives from
`user_config`. The onboarding script in OpenAssistant (`onboard-user.sh`,
planned) must own this as part of its person registry.

## Flags (in `~/OpenBrain/.env`, read at container start)

- `SCOPE_ENFORCE=1` — read enforcement (`search_thoughts`, `list_thoughts`). Unset/0 = shadow (log-only).
- `SCOPE_ENFORCE_WRITES=1` — write + `thought_stats` enforcement. Independent flag so each flip is separately reversible.
- Both are **live =1** in production since s57/s64.

## Key → agent map (`src/index.ts`)

| Env var | Agent | read_scope (from `user_config`) |
|---|---|---|
| `MCP_ACCESS_KEY` | `dan` | `["dan","family"]` |
| `MCP_ACCESS_KEY_NICOLE` | `nicole` | `["family","nicole"]` |
| `MCP_ACCESS_KEY_DESKTOP` | `dan-desktop` | `["dan","family"]` |

`read_scope` rows are seeded/managed by OpenAssistant `scripts/read-scope.py`
(single source of truth = the DB row, never duplicated in code). Unmapped or
missing keys → 401 on `/sse`.

**Rotation touchpoints for `MCP_ACCESS_KEY_DESKTOP`** (the value lives in
THREE places): `~/OpenBrain/.env` on the VM (server side), and on Dan's Mac
`~/.config/openassistant/mcp-desktop.key` (probe) + the `env` block of
`~/Library/Application Support/Claude/claude_desktop_config.json` (Desktop,
0600). Rotation updates all three, file→file, never printed. **Revocation
needs only the first**: delete the line, `docker compose up -d api`.

## Tests

Run in a throwaway node:22 container (the host has no node):

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v ~/OpenBrain:/app -w /app node:22 \
  bash -c "npm ci --no-audit --no-fund && npx tsc --noEmit && npm test"
```

- **Must be green, always:** `src/mcp/__tests__/scope.test.ts` (the fork's
  regression net — shadow vs enforce, unset-read narrowing, cross-person
  rejects, the D-105 `system`-namespace case, empty-scope fail-safe, write
  gates) and `src/mcp/__tests__/server.test.ts`.
- **Known-fail baseline (as of s67): exactly 13 failures**, all
  `CaptureValidationError: created_by is required`, confined to
  `src/api/__tests__/validation.test.ts`, `routes.test.ts`,
  `provenance.test.ts` — upstream fixtures don't send `created_by`, which
  commit `12b043b` made mandatory. **Any failure outside this set is real.**
  (Future fix: derive the whitelist from `user_config` and adapt fixtures —
  pair it with the onboarding work.)

## Upstream sync policy

Sync **on need** (a feature we want, or a security fix), not on cadence. The
nightly pinned-update gate covers OpenClaw images only — **nothing auto-updates
this fork.**

1. `git fetch origin` → read `CHANGELOG.md` and `git log master..origin/master`.
2. **Merge, don't rebase** (`git merge origin/master`) — local history stays
   stable and the delta inventory above stays true.
3. Expected conflict hotspots: `src/mcp/server.ts`, `src/index.ts`,
   `src/api/validation.ts`, `docker-compose.yml`.
4. Run the test container (above): scope + server suites green, known-fail
   baseline unchanged.
5. Redeploy: `docker compose build && docker compose up -d api` (compose owns
   the image — never `docker build` by hand).
6. Exercise the live rail from OpenAssistant (no LLM): `scripts/mcp-scope-probe.py`
   — in-scope read exits 0, cross-person read/write exits 2, e.g.
   `python3 ~/scripts/mcp-scope-probe.py --key-env MCP_ACCESS_KEY_NICOLE --tool search_thoughts --args '{"query":"x","created_by":"dan"}'` → exit 2.
7. Record the sync as a journal entry / decision-log note in OpenAssistant
   (`docs/12`, S-4 discipline lives there, not here).
