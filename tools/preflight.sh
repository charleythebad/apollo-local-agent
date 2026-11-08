#!/bin/bash
# tools/preflight.sh — one-command health check before any restart.
# Read-only: changes no files, places no orders, posts nothing to Discord.
# Prints a plain-English line per check: ✅ pass, ⚠️  worth a look, ❌ must fix.
# Usage: tools/preflight.sh            full check
#        tools/preflight.sh --offline  skip checks that need a running service
# Exit 0 = no ❌, exit 1 = at least one ❌. Warnings never fail the run.

ROOT="${APOLLO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
OFFLINE=0; [ "$1" = "--offline" ] && OFFLINE=1

# Expected state — edit these when something is deliberately changed, so drift
# from what you decided shows up here instead of in production.
PM2_ONLINE="${PREFLIGHT_PM2:-apollo}"            # pm2 apps that must be online
MODEL="${PREFLIGHT_MODEL:-}"                      # Ollama model to pin, e.g. name:tag
MODEL_ID="${PREFLIGHT_MODEL_ID:-}"                # first 12 chars of its digest
ENV_NEEDED="DISCORD_TOKEN PRINCIPAL_ID APOLLO_ROOT OLLAMA_URL CHANNEL_COMMAND CHANNEL_HEALTH CHANNEL_LOGS"
KILL_FILE="${PREFLIGHT_KILL_FILE:-}"              # optional: a trading skill's stop file
BACKUP_MAX_H=30

FAILS=0; WARNS=0
ok()   { echo "  ✅ $*"; }
warn() { echo "  ⚠️  $*"; WARNS=$((WARNS+1)); }
fail() { echo "  ❌ $*"; FAILS=$((FAILS+1)); }
section() { echo; echo "$*"; }

echo "Preflight — $(date '+%Y-%m-%d %H:%M')$([ $OFFLINE = 1 ] && echo ' (offline)')"

section "1. Code parses"
bad=0; n=0
for f in "$ROOT"/*.js "$ROOT"/modules/*.js "$ROOT"/tools/*.js "$ROOT"/tests/*.js; do
  [ -f "$f" ] || continue; n=$((n+1))
  node --check "$f" 2>/dev/null || { fail "JavaScript error in ${f#$ROOT/}"; bad=1; }
done
[ $bad = 0 ] && ok "$n JavaScript files parse"
bad=0; n=0
for f in "$ROOT"/tools/*.sh "$ROOT"/examples/*.sh; do
  [ -f "$f" ] || continue; n=$((n+1))
  bash -n "$f" 2>/dev/null || { fail "shell script error in ${f#$ROOT/}"; bad=1; }
done
[ $bad = 0 ] && ok "$n shell scripts parse"

section "2. Governing documents"
out=$(cd "$ROOT" && node tools/docs_audit.js 2>&1)
if [ $? = 0 ]; then ok "${out%%$'\n'*}"; else fail "docs audit found drift:"; echo "$out" | sed 's/^/       /'; fi

section "3. Settings and secrets (names only, values never shown)"
if [ ! -f "$ROOT/.env" ]; then fail "no .env — copy .env.example and fill it in"
else
  missing=""
  for v in $ENV_NEEDED; do grep -q "^$v=." "$ROOT/.env" 2>/dev/null || missing="$missing $v"; done
  [ -z "$missing" ] && ok "all $(echo $ENV_NEEDED | wc -w | tr -d ' ') required settings present" || fail "missing or empty in .env:$missing"
fi
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  if git -C "$ROOT" ls-files --error-unmatch .env >/dev/null 2>&1; then fail ".env is tracked by git — remove it from the repo and rotate every key in it"
  else ok ".env is not tracked by git"; fi
fi

section "4. Services"
if [ $OFFLINE = 1 ]; then warn "skipped service checks (offline)"
else
  pm2json=$(pm2 jlist 2>/dev/null)
  for app in $PM2_ONLINE; do
    st=$(echo "$pm2json" | jq -r --arg n "$app" '.[] | select(.name==$n) | .pm2_env.status' 2>/dev/null)
    [ "$st" = "online" ] && ok "$app running" || fail "$app is ${st:-not in pm2}"
  done
  base="${OLLAMA_URL:-http://localhost:11434}"
  tags=$(curl -s --max-time 5 "$base/api/tags")
  if [ -z "$tags" ]; then fail "Ollama not answering at $base"
  elif [ -z "$MODEL" ]; then warn "Ollama up; no model pinned (set PREFLIGHT_MODEL and PREFLIGHT_MODEL_ID)"
  else
    id=$(echo "$tags" | jq -r --arg m "$MODEL" '.models[] | select(.name==$m) | .digest[0:12]')
    if [ -z "$id" ]; then fail "model $MODEL not installed"
    elif [ "$id" = "$MODEL_ID" ]; then ok "Ollama up, $MODEL is the pinned version ($MODEL_ID)"
    else warn "$MODEL changed: now $id, expected $MODEL_ID — rerun tests, then update the pin"; fi
  fi
fi

section "5. Backup"
lr="${BACKUP_DEST:-$HOME/Backups/ApolloBackups}/last_run.json"
if [ ! -f "$lr" ]; then warn "no backup status file yet ($lr) — run tools/nightly_backup.sh"
else
  st=$(jq -r .status "$lr"); ts=$(jq -r .ts "$lr")
  age=$(python3 -I -c 'import sys,datetime as d; print(int((d.datetime.now(d.timezone.utc)-d.datetime.fromisoformat(sys.argv[1])).total_seconds()//3600))' "$ts" 2>/dev/null)
  if [ "$st" != "ok" ]; then fail "last backup status: $st"
  elif [ -z "$age" ] || [ "$age" -gt $BACKUP_MAX_H ]; then fail "last good backup is ${age:-?}h old"
  else ok "last backup ok, ${age}h ago ($(jq -r .size "$lr"))"; fi
fi

section "6. Scheduled jobs"
if [ ! -f "$ROOT/jobs.json" ]; then ok "no jobs.json (no scheduled jobs)"
elif ! node -e "require('$ROOT/modules/jobs_runner.js').loadJobs('$ROOT/jobs.json')" 2>/dev/null; then
  fail "jobs.json unreadable or invalid (bad cron, missing argv or channel, or duplicate name)"
else
  on=$(node -e "console.log(require('$ROOT/modules/jobs_runner.js').loadJobs('$ROOT/jobs.json').filter(j=>j.enabled).map(j=>j.name).join(' '))")
  ok "jobs.json valid, $(echo $on | wc -w | tr -d ' ') job(s) on${on:+: $on}"
fi

section "7. Kill switch"
if [ -z "$KILL_FILE" ]; then ok "no kill switch configured"
elif [ -f "$KILL_FILE" ]; then warn "KILL file present — trading is stopped on purpose?"
else ok "no KILL file — trading skill acts only on approval"; fi

section "8. Tests"
n=0; bad=0
for t in "$ROOT"/tests/*.test.js; do
  [ -f "$t" ] || continue; n=$((n+1))
  node "$t" >/dev/null 2>&1 || { fail "test failed: ${t#$ROOT/}"; bad=1; }
done
if [ $n = 0 ]; then warn "no tests yet — add tests/*.test.js"
elif [ $bad = 0 ]; then ok "$n test files pass"; fi

section "9. History"
if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then fail "$ROOT is not a git repo — changes have no history"
else
  dirty=$(git -C "$ROOT" status --porcelain | wc -l | tr -d ' ')
  [ "$dirty" = 0 ] && ok "no uncommitted changes" \
    || warn "$dirty uncommitted change(s) — review with git status, then commit"
fi

echo
if [ $FAILS = 0 ]; then echo "RESULT: ✅ ready — $WARNS warning(s)"; exit 0
else echo "RESULT: ❌ $FAILS problem(s) to fix, $WARNS warning(s) — don't restart until fixed"; exit 1; fi
