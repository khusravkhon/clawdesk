#!/bin/sh
# Gateway container start: the ClawDesk bridge in the background, then OpenClaw as PID 1's child.
# One-off commands (`compose run --entrypoint …`) bypass this script.
case "$*" in
  *" gateway"*)
    # OpenClaw moves deleted agents here. Clear old contents before the Gateway uses it again.
    trash=/home/node/.Trash
    if [ -d "$trash" ] && [ ! -L "$trash" ]; then
      find -P "$trash" -xdev -mindepth 1 -depth -delete || echo "ClawDesk: could not empty the Gateway trash at $trash" >&2
    fi
    node /usr/local/lib/clawdesk-plugin-repair.mjs || exit 1
    node /usr/local/lib/clawdesk-bridge.mjs &
    ;;
esac
exec "$@"
