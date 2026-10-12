#!/bin/sh
# Wrapper around the Docker CLI inside the Gateway image.
#
# OpenClaw sandboxes bind an agent workspace (rw) and then bind skills *into* it, e.g.
#   -v /…/workspace/coach:/workspace  -v /…/skills-workspaces/x/skills:/workspace/.openclaw/sandbox-skills/skills:ro
# When the inner mount point does not exist yet, the Docker daemon creates it inside the
# workspace as root. The Gateway runs as "node" and can then never delete that workspace:
# agents.delete leaves files behind and the next Gateway start fails
# ("agent database is unavailable while agent <id> is deleted").
#
# Before `docker create|run`, pre-create such nested mount points as the Gateway user,
# so Docker finds them and keeps the workspace owned by node. Everything else passes through.

REAL_DOCKER=/usr/local/libexec/docker

if [ "$1" = "create" ] || [ "$1" = "run" ]; then
  binds=""
  prev=""
  for arg in "$@"; do
    case "$prev" in
      -v | --volume) binds="$binds$arg
" ;;
    esac
    case "$arg" in
      --volume=*) binds="$binds${arg#--volume=}
" ;;
    esac
    prev="$arg"
  done

  # Host paths only (absolute); named volumes have no directory to prepare.
  printf '%s' "$binds" | while IFS= read -r outer; do
    outer_src=${outer%%:*}
    outer_rest=${outer#*:}
    outer_dst=${outer_rest%%:*}
    outer_opts=""
    [ "$outer_rest" != "$outer_dst" ] && outer_opts=${outer_rest#*:}
    case "$outer_src" in /*) ;; *) continue ;; esac
    case ",$outer_opts," in *,ro,*) continue ;; esac
    [ -d "$outer_src" ] || continue

    printf '%s' "$binds" | while IFS= read -r inner; do
      inner_rest=${inner#*:}
      inner_dst=${inner_rest%%:*}
      case "$inner_dst" in
        "$outer_dst"/*) mkdir -p "$outer_src/${inner_dst#"$outer_dst"/}" 2>/dev/null || true ;;
      esac
    done
  done
fi

exec "$REAL_DOCKER" "$@"
