#!/usr/bin/env bash
# Governor OS — operator smoke-test
# Usage:
#   BASE_URL=http://localhost:3000 ADMIN_SECRET=your-secret bash scripts/smoke-test.sh
#
# Exits 0 if all checks pass; exits 1 on any failure.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
SMOKE_ORG_ID="smoke-test-$(date +%s)"

PASS=0
FAIL=0
SKIP=0

pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); }
skip() { echo "[SKIP] $1"; SKIP=$((SKIP + 1)); }

echo "Governor OS smoke test — ${BASE_URL}"
echo "--------------------------------------------"

# ── 1. Health check ─────────────────────────────────────────────────────────
status=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/health")
body=$(curl -s "${BASE_URL}/health")

if [ "$status" = "200" ] && echo "$body" | grep -q '"status":"ok"'; then
  pass "GET /health → 200 {\"status\":\"ok\"}"
else
  fail "GET /health → expected 200 {\"status\":\"ok\"}, got HTTP ${status}: ${body}"
fi

# ── 2–4. Admin org lifecycle (requires ADMIN_SECRET) ─────────────────────────
if [ -z "${ADMIN_SECRET:-}" ]; then
  skip "POST /admin/orgs  — ADMIN_SECRET not set, skipping admin checks"
  skip "GET  /admin/orgs  — ADMIN_SECRET not set, skipping admin checks"
  skip "DELETE /admin/orgs/:id — ADMIN_SECRET not set, skipping admin checks"
else
  AUTH_HEADER="Authorization: Bearer ${ADMIN_SECRET}"

  # 2. Create test org
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${BASE_URL}/admin/orgs" \
    -H "Content-Type: application/json" \
    -H "${AUTH_HEADER}" \
    -d "{\"id\":\"${SMOKE_ORG_ID}\",\"licenseKey\":\"smoke-key-$(date +%s)\",\"allowedSubs\":[\"repo:smoke/*\"]}")

  if [ "$status" = "201" ]; then
    pass "POST /admin/orgs → 201 (org created)"
  else
    fail "POST /admin/orgs → expected 201, got HTTP ${status}"
  fi

  # 3. Verify org appears in list
  list_body=$(curl -s "${BASE_URL}/admin/orgs" -H "${AUTH_HEADER}")
  list_status=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/admin/orgs" -H "${AUTH_HEADER}")

  if [ "$list_status" = "200" ] && echo "$list_body" | grep -q "\"id\":\"${SMOKE_ORG_ID}\""; then
    pass "GET  /admin/orgs → 200 (test org present)"
  else
    fail "GET  /admin/orgs → expected 200 with org ${SMOKE_ORG_ID}, got HTTP ${list_status}: ${list_body}"
  fi

  # 4. Delete test org
  del_status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X DELETE "${BASE_URL}/admin/orgs/${SMOKE_ORG_ID}" \
    -H "${AUTH_HEADER}")

  if [ "$del_status" = "204" ]; then
    pass "DELETE /admin/orgs/:id → 204 (org removed)"
  else
    fail "DELETE /admin/orgs/:id → expected 204, got HTTP ${del_status}"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo "--------------------------------------------"
echo "Results: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"

if [ "$FAIL" -gt 0 ]; then
  echo "SMOKE TEST FAILED"
  exit 1
fi

echo "SMOKE TEST PASSED"
exit 0
