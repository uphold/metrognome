#!/bin/sh
# Keep the Callstack CLIs metrognome drives on @latest. At most once a day, detached,
# never blocks or fails session start. Only touches CLIs already installed globally.
STAMP="${CLAUDE_PLUGIN_ROOT}/.cli-update-stamp"

if [ "$1" != --bg ]; then
  # Done today, or failed within the hour (offline, EACCES on a system node) → back off.
  [ -n "$(find "$STAMP" -mtime -1 2>/dev/null)$(find "$STAMP.fail" -mmin -60 2>/dev/null)" ] && exit 0
  [ -w "${CLAUDE_PLUGIN_ROOT}" ] || exit 0
  # Own session so a process-group kill of the hook can't take the update down with it.
  # setsid(1) isn't on macOS; node's detached spawn calls setsid(2) everywhere.
  node -e 'require("child_process").spawn("sh", [process.argv[1], "--bg"], { detached: true, stdio: "ignore" }).unref()' "$0" 2>/dev/null
  exit 0
fi

# One updater at a time — concurrent `npm i -g` of the same package corrupts the install.
# A lock older than an hour is left over from a killed run.
find "$STAMP.lock" -maxdepth 0 -mmin +60 -exec rmdir {} \; 2>/dev/null
mkdir "$STAMP.lock" 2>/dev/null || exit 0
trap 'rmdir "$STAMP.lock"' EXIT

# Stamp only once every check succeeds; a failure retries after an hour, not a day.
fail() { touch "$STAMP.fail"; exit 1; }
for pkg in agent-device agent-react-devtools; do
  cur=$(npm ls -g --depth=0 "$pkg" 2>/dev/null | grep -o "$pkg@[^ ]*" | cut -d@ -f2)
  [ -n "$cur" ] || continue
  case $cur in *-*) continue ;; esac # ponytail: prerelease/canary installs are left alone; no semver compare
  latest=$(npm view "$pkg" version 2>/dev/null)
  [ -n "$latest" ] || fail
  [ "$cur" = "$latest" ] || npm i -g "$pkg@latest" --quiet || fail
done
touch "$STAMP"
rm -f "$STAMP.fail"
