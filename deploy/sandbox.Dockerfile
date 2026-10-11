# syntax=docker/dockerfile:1
# Default OpenClaw agent sandbox image (openclaw-sandbox:bookworm-slim), as
# documented in OpenClaw's gateway/sandboxing guide for npm installs. Agents run
# tools here with no network, a read-only root and only their own workspace.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*
# uid 1000 matches the Gateway's "node" user, so files in agent workspaces stay writable for both.
RUN useradd --create-home --uid 1000 --shell /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox
CMD ["sleep", "infinity"]
