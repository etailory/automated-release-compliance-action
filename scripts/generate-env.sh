#!/bin/sh
# Governor OS — bootstrap production secrets
#
# Usage:
#   scripts/generate-env.sh [--print] [--force]
#
#   --print   Write to stdout instead of .env (useful for piping / inspection)
#   --force   Overwrite an existing .env without prompting
#
# Reads .env.example from the repo root as a template and replaces every
# change-me-* placeholder for SESSION_SECRET, ADMIN_SECRET, and LICENSE_SECRET
# with a fresh cryptographic value from `openssl rand -hex 32`.
# All other lines (comments, optional vars, PORT=3000, etc.) are kept verbatim.

set -eu

# ── Parse arguments ──────────────────────────────────────────────────────────
PRINT=0
FORCE=0
for _arg in "$@"; do
  case "$_arg" in
    --print) PRINT=1 ;;
    --force) FORCE=1 ;;
    *)
      printf 'Error: unknown option: %s\n' "$_arg" >&2
      printf 'Usage: %s [--print] [--force]\n' "$0" >&2
      exit 1
      ;;
  esac
done

# ── Locate repo root (script lives in scripts/) ──────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
ENV_OUT="$ROOT_DIR/.env"

# ── Pre-flight checks ────────────────────────────────────────────────────────
if ! command -v openssl >/dev/null 2>&1; then
  printf 'Error: openssl is not available. Install it and try again.\n' >&2
  exit 1
fi

if [ ! -f "$ENV_EXAMPLE" ]; then
  printf 'Error: %s not found.\n' "$ENV_EXAMPLE" >&2
  exit 1
fi

# ── Prompt before overwrite (unless --force or --print) ─────────────────────
if [ "$PRINT" -eq 0 ] && [ -f "$ENV_OUT" ] && [ "$FORCE" -eq 0 ]; then
  printf '%s already exists. Overwrite? [y/N] ' "$ENV_OUT"
  read -r _answer
  case "$_answer" in
    [Yy]*) ;;
    *)
      printf 'Aborted.\n' >&2
      exit 1
      ;;
  esac
fi

# ── Generate secrets ─────────────────────────────────────────────────────────
_session="$(openssl rand -hex 32)"
_admin="$(openssl rand -hex 32)"
_license="$(openssl rand -hex 32)"

# ── Process template (POSIX read loop, handles files with no trailing newline)
_process() {
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in
      SESSION_SECRET=change-me-*)
        printf 'SESSION_SECRET=%s\n' "$_session" ;;
      ADMIN_SECRET=change-me-*)
        printf 'ADMIN_SECRET=%s\n' "$_admin" ;;
      LICENSE_SECRET=change-me-*)
        printf 'LICENSE_SECRET=%s\n' "$_license" ;;
      *)
        printf '%s\n' "$_line" ;;
    esac
  done < "$ENV_EXAMPLE"
}

# ── Output ───────────────────────────────────────────────────────────────────
if [ "$PRINT" -eq 1 ]; then
  _process
else
  _process > "$ENV_OUT"
  printf 'Generated %s with fresh secrets.\n' "$ENV_OUT"
  printf 'You can now run: docker compose up -d\n'
fi
