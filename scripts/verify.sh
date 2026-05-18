#!/usr/bin/env bash
# Universal Open Brain deployment smoke test.
#
# Runs the same 4 checks against ANY Open Brain deployment — local Docker, K8s,
# Azure, Fly.io, Render, Railway. If all four pass, you have a working Open Brain.
#
# Usage:
#   ./scripts/verify.sh <api-url>          # e.g. http://localhost:8000
#   OPENBRAIN_API_URL=... ./scripts/verify.sh
#   ./scripts/verify.sh https://x.fly.dev https://x.fly.dev  # api + mcp url
#
# Requires: bash, curl, jq.

set -u

API_URL="${1:-${OPENBRAIN_API_URL:-}}"
MCP_URL="${2:-}"

if [[ -z "$API_URL" ]]; then
    echo "Usage: $0 <api-url>  (or set OPENBRAIN_API_URL)"
    echo "Example: $0 http://localhost:8000"
    exit 2
fi

# strip trailing slash
API_URL="${API_URL%/}"
MCP_URL="${MCP_URL%/}"

if ! command -v jq >/dev/null 2>&1; then
    echo "  ⚠ 'jq' not installed — install it for nicer output (apt install jq | brew install jq)"
    HAS_JQ=0
else
    HAS_JQ=1
fi

PASS=0
FAIL=0
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'

step() {
    local name="$1"; shift
    printf "  %s ... " "$name"
    if "$@" >/tmp/openbrain-verify.out 2>&1; then
        printf "${GREEN}OK${NC}\n"
        PASS=$((PASS + 1))
        return 0
    else
        printf "${RED}FAIL${NC}\n"
        sed 's/^/    /' /tmp/openbrain-verify.out | head -5
        FAIL=$((FAIL + 1))
        return 1
    fi
}

echo
echo -e "  ${CYAN}Open Brain — Deployment Smoke Test${NC}"
echo -e "  ${DIM}Target: $API_URL${NC}"
echo

# ── 1. REST health ──────────────────────────────────────────────────
check_rest_health() {
    local body
    body=$(curl -fsS --max-time 30 "$API_URL/health") || return 1
    echo "$body" | grep -q '"status":"healthy"' || { echo "Got: $body"; return 1; }
}
step "REST /health" check_rest_health

# ── 2. MCP health (optional) ────────────────────────────────────────
if [[ -n "$MCP_URL" ]]; then
    check_mcp_health() {
        local body
        body=$(curl -fsS --max-time 30 "$MCP_URL/health") || return 1
        echo "$body" | grep -q '"status":"healthy"' || { echo "Got: $body"; return 1; }
    }
    step "MCP  /health ($MCP_URL)" check_mcp_health
fi

# ── 3. Capture a thought ────────────────────────────────────────────
MARKER="openbrain-verify-$RANDOM$RANDOM"
CONTENT="Smoke-test thought from verify.sh. Marker: $MARKER. This thought is safe to delete."
THOUGHT_ID=""

capture_thought() {
    local body
    body=$(curl -fsS --max-time 60 -X POST "$API_URL/memories" \
        -H "Content-Type: application/json" \
        -d "{\"content\":\"$CONTENT\",\"source\":\"verify-script\"}") || return 1
    if [[ $HAS_JQ -eq 1 ]]; then
        THOUGHT_ID=$(echo "$body" | jq -r '.id // empty')
    else
        THOUGHT_ID=$(echo "$body" | grep -oE '"id":"[^"]+"' | head -1 | cut -d'"' -f4)
    fi
    if [[ -z "$THOUGHT_ID" ]]; then echo "No id in response: $body"; return 1; fi
}
step "POST /memories (capture)" capture_thought

# ── 4. Search for it (full pipeline: embed → vector search) ─────────
search_thought() {
    local body matches
    body=$(curl -fsS --max-time 60 -X POST "$API_URL/memories/search" \
        -H "Content-Type: application/json" \
        -d "{\"query\":\"smoke test verification marker $MARKER\",\"limit\":5}") || return 1
    if [[ $HAS_JQ -eq 1 ]]; then
        matches=$(echo "$body" | jq -r --arg id "$THOUGHT_ID" '.[] | select(.id == $id) | .id')
    else
        matches=$(echo "$body" | grep -oE "\"id\":\"$THOUGHT_ID\"")
    fi
    if [[ -z "$matches" ]]; then
        echo "Captured thought not in top 5 results — search recall problem"
        echo "Response: $body"
        return 1
    fi
}
step "POST /memories/search (semantic search)" search_thought

# ── 5. Cleanup ──────────────────────────────────────────────────────
if [[ -n "$THOUGHT_ID" ]]; then
    cleanup() {
        curl -fsS --max-time 30 -X DELETE "$API_URL/memories/$THOUGHT_ID" -o /dev/null
    }
    step "DELETE /memories/$THOUGHT_ID (cleanup)" cleanup
fi

# ── Summary ─────────────────────────────────────────────────────────
echo
if [[ $FAIL -eq 0 ]]; then
    echo -e "  ${GREEN}✓ All $PASS checks passed — your Open Brain deployment is healthy.${NC}"
    echo
    exit 0
else
    TOTAL=$((PASS + FAIL))
    echo -e "  ${RED}✗ $FAIL of $TOTAL checks failed.${NC}"
    echo -e "  ${YELLOW}  See docs/TROUBLESHOOTING.md for help.${NC}"
    echo
    exit 1
fi
