#!/usr/bin/env bash
# AakashVani safe cleanup — removes redundant dirs and build junk.
# Dry-run by default: pass --apply to actually delete.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGETS=(
  # Duplicate root virtualenv (backend has its own)
  "$ROOT/venv"
  # Stale bytecode for deleted source modules
  "$ROOT/backend/__pycache__"
  "$ROOT/backend/app/__pycache__"
  "$ROOT/backend/app/routers/__pycache__"
  "$ROOT/backend/app/services/__pycache__"
  "$ROOT/backend/third_party/iitm_indic_tts/__pycache__"
  "$ROOT/backend/third_party/iitm_indic_tts/hifigan/__pycache__"
)

echo "== Dry run (use --apply to delete) =="
for t in "${TARGETS[@]}"; do
  if [ -e "$t" ]; then
    du -sh "$t" 2>/dev/null || true
    if [ "${1:-}" = "--apply" ]; then
      rm -rf "$t" && echo "  deleted: $t"
    else
      echo "  would delete: $t"
    fi
  else
    echo "  (missing, skip): $t"
  fi
done

if [ "${1:-}" != "--apply" ]; then
  echo "== NOTE: nothing deleted. Review the list above, then run: $0 --apply =="
fi
