#!/usr/bin/env bash
# Minimal Obelisk REST client.  Usage: obelisk.sh METHOD PATH [JSON_BODY]
#   OBELISK_URL   defaults to {{OBELISK_URL}}
#   OBELISK_TOKEN personal API token (obk_…) from Obelisk → 설정 → AI 연결
set -euo pipefail
METHOD="${1:?method required (GET/POST/PATCH/DELETE)}"
PATH_="${2:?path required, e.g. /api/tasks?view=today}"
BODY="${3:-}"
URL="${OBELISK_URL:-{{OBELISK_URL}}}"
: "${OBELISK_TOKEN:?set OBELISK_TOKEN to a personal API token}"
args=(-sS -X "$METHOD" "${URL%/}${PATH_}" -H "Authorization: Bearer ${OBELISK_TOKEN}" -H "Accept: application/json")
if [[ -n "$BODY" ]]; then args+=(-H "Content-Type: application/json" --data "$BODY"); fi
curl "${args[@]}"
echo
