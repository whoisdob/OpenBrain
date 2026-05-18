# scripts/

Helper scripts for Open Brain deployments.

| Script | Use it to… |
|--------|------------|
| `verify.ps1` / `verify.sh` | Run a 4-step smoke test against ANY Open Brain deployment URL (local, Azure, Fly, K8s, …) |

## verify

Quick sanity check — captures a test thought, searches for it, then deletes it. Works against any deployment.

```bash
# Linux / macOS
./scripts/verify.sh http://localhost:8000

# Windows PowerShell
.\scripts\verify.ps1 http://localhost:8000

# Hosted
./scripts/verify.sh https://openbrain-<your-handle>.fly.dev

# Or via env var
OPENBRAIN_API_URL=https://openbrain.example.com ./scripts/verify.sh
```

Exit codes: `0` = all checks passed, `1` = at least one check failed, `2` = bad usage.

If anything fails, see [docs/TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md).
