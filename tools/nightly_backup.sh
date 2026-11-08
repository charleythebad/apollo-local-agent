#!/bin/bash
# Nightly backup of the agent's state: plain file mirror (no archives),
# built fresh alongside the current snapshot and atomically swapped in only
# after a successful, verified copy. Keeps 3 rotating snapshots (current,
# prev.1, prev.2) so one bad night can't propagate into the only restore
# point; hardlinks via --link-dest keep the extra snapshots nearly free.
#
# On any failure: writes status=fail to last_run.json (surfaced by !health)
# and fires a macOS notification. Success writes status=ok.
#
# DEST stays local (health.js reads the same BACKUP_DEST default). Copy the
# verified snapshot off-machine (e.g. an encrypted external drive) as a second
# step that can fail without spoiling the local one.
#
# SOURCES: space-separated folders to back up (default: $APOLLO_ROOT).
# VERIFY: files (relative to DEST snapshot) that must exist before rotation.
set -Eeuo pipefail

DEST="${BACKUP_DEST:-$HOME/Backups/ApolloBackups}"
SRC="${SOURCES:-$APOLLO_ROOT}"
MIRROR="$DEST/current"
NEW="$DEST/.building"
STATUS="$DEST/last_run.json"

fail_alert() {
  local msg="$1"
  printf '{"ts":"%s","status":"fail","detail":"%s"}\n' "$(date -Iseconds)" "$msg" > "$STATUS" 2>/dev/null || true
  osascript -e "display notification \"$msg\" with title \"Apollo nightly backup FAILED\"" 2>/dev/null || true
  echo "[backup] FAILED: $msg"
}
die() { fail_alert "$1"; exit 1; }
trap 'fail_alert "nightly_backup.sh failed at line $LINENO"' ERR

mkdir -p "$DEST"
rm -rf "$NEW"

echo "[backup] $(date '+%F %T') building fresh mirror -> $NEW"
mkdir -p "$NEW"
# shellcheck disable=SC2086
rsync -a --delete --exclude='node_modules/' --exclude='tmp/' --exclude='cache/' \
  --link-dest="$MIRROR" $SRC "$NEW/"

# Verify the copy holds the crown jewels before touching any old snapshot
base=$(basename "$APOLLO_ROOT")
for f in ${VERIFY:-"$base/.git/HEAD" "$base/.env" "$base/version_index.json"}; do
  [ -e "$NEW/$f" ] || die "VERIFY FAILED: $f missing — old snapshots untouched"
done
cmp -s "$NEW/$base/version_index.json" "$APOLLO_ROOT/version_index.json" || \
  die "VERIFY FAILED: version_index.json mismatch — old snapshots untouched"

# Rotate: oldest falls off, current becomes prev.1, verified build becomes current
rm -rf "$DEST/prev.2"
[ -d "$DEST/prev.1" ] && mv "$DEST/prev.1" "$DEST/prev.2"
[ -d "$MIRROR" ] && mv "$MIRROR" "$DEST/prev.1"
mv "$NEW" "$MIRROR"

SIZE=$(du -sh "$MIRROR" | cut -f1)
printf '{"ts":"%s","status":"ok","size":"%s"}\n' "$(date -Iseconds)" "$SIZE" > "$STATUS"
echo "[backup] $(date '+%F %T') done — snapshot rotated in ($SIZE at $MIRROR)"
