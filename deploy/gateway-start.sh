#!/bin/sh
# Gateway container start: the ClawDesk bridge in the background, then OpenClaw as PID 1's child.
# One-off commands (`compose run --entrypoint …`) bypass this script.
case "$*" in
  *" gateway"*)
    node /usr/local/lib/clawdesk-plugin-repair.mjs || exit 1
    node /usr/local/lib/clawdesk-bridge.mjs &
    ;;
esac
exec "$@"
