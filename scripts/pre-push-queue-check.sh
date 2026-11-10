#!/usr/bin/env bash
# pre-push hook: refuse to push `main` while a conversion is queued or running.
#
# Why: every push to main auto-deploys Render, which restarts the container
# and kills the chapter in flight — the user loses the whole book's elapsed
# time (chapter rows are only written at the end). This rule was answered
# from memory and broken on 2026-05-28, 2026-09-11 and 2026-09-12. A hook
# cannot forget.
#
# Install (once per clone):
#   ln -sf ../../scripts/pre-push-queue-check.sh .git/hooks/pre-push
#
# Override for a genuine emergency (the queue really is the thing you're fixing):
#   SKIP_QUEUE_CHECK=1 git push
#
# Fails CLOSED: if the endpoint can't be reached or errors, the push is refused —
# "unknown" is not "empty".

set -u
API="${EBOOKVOICE_API_URL:-http://localhost:8080}"

# git passes "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin
pushing_main=0
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/main) pushing_main=1 ;;
  esac
done
[ "$pushing_main" = 1 ] || exit 0

if [ "${SKIP_QUEUE_CHECK:-}" = "1" ]; then
  echo "[pre-push] SKIP_QUEUE_CHECK=1 — queue check bypassed" >&2
  exit 0
fi

body=$(curl -sS --max-time 15 -w '\n%{http_code}' "$API/api/queue-status" 2>/dev/null) || {
  echo "[pre-push] REFUSED — could not reach $API/api/queue-status (network). Unknown is not empty." >&2
  exit 1
}
code=$(printf '%s' "$body" | tail -n1)
json=$(printf '%s' "$body" | sed '$d')

if [ "$code" != "200" ]; then
  echo "[pre-push] REFUSED — queue-status returned HTTP $code: $json" >&2
  exit 1
fi

queued=$(printf '%s' "$json" | sed -n 's/.*"queued":[[:space:]]*\([0-9]*\).*/\1/p')
processing=$(printf '%s' "$json" | sed -n 's/.*"processing":[[:space:]]*\([0-9]*\).*/\1/p')

if [ -z "$queued" ] || [ -z "$processing" ]; then
  echo "[pre-push] REFUSED — could not parse queue-status response: $json" >&2
  exit 1
fi

if [ "$queued" -gt 0 ] || [ "$processing" -gt 0 ]; then
  echo "[pre-push] REFUSED — a conversion is in flight (queued=$queued processing=$processing)." >&2
  echo "           A push deploys Render and restarts the container mid-book. Wait for it to finish." >&2
  exit 1
fi

echo "[pre-push] queue empty (queued=0 processing=0) — push allowed"
exit 0
