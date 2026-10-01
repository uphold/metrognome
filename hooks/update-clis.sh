#!/bin/sh
# Keep the Callstack CLIs metrognome drives on @latest. At most once a day, detached,
# never blocks or fails session start. Only touches CLIs already installed globally.
STAMP="${CLAUDE_PLUGIN_ROOT}/.cli-update-stamp"
[ -n "$(find "$STAMP" -mtime -1 2>/dev/null)" ] && exit 0
touch "$STAMP" 2>/dev/null || exit 0

nohup sh -c '
  for pkg in agent-device agent-react-devtools; do
    cur=$(npm ls -g --depth=0 "$pkg" 2>/dev/null | grep -o "$pkg@[^ ]*" | cut -d@ -f2)
    [ -n "$cur" ] || continue
    latest=$(npm view "$pkg" version 2>/dev/null)
    [ -n "$latest" ] && [ "$cur" != "$latest" ] && npm i -g "$pkg@latest" --quiet
  done
' </dev/null >/dev/null 2>&1 &

exit 0
