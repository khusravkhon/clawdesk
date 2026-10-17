# syntax=docker/dockerfile:1
# OpenClaw Gateway + Docker CLI, so it can start sandbox containers for junior
# agents (decision 2: sandbox for every junior agent). The Gateway talks to the
# host Docker daemon through the mounted socket ("Docker-out-of-Docker").
ARG OPENCLAW_VERSION=2026.8.1
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw

FROM docker:29-cli AS docker-cli

# Google Workspace CLI for OpenClaw's bundled gog skill (Drive/Docs/Gmail source). Pinned and checksummed.
FROM debian:bookworm-slim AS gog
ARG GOG_VERSION=0.42.0
ADD --checksum=sha256:1967a962a57d689958c408dd0abc784792c3712da9d0a90650bb76ab7e3de388 \
  https://github.com/openclaw/gogcli/releases/download/v${GOG_VERSION}/gogcli_${GOG_VERSION}_linux_amd64.tar.gz /tmp/gog.tgz
RUN mkdir /tmp/gog && tar xzf /tmp/gog.tgz -C /tmp/gog && install -m 0755 /tmp/gog/gog /usr/local/bin/gog

FROM ${OPENCLAW_IMAGE}:${OPENCLAW_VERSION}
# The real CLI sits behind a wrapper that keeps agent workspaces owned by the Gateway
# user (see docker-mountpoints.sh); OpenClaw keeps calling plain `docker`.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/libexec/docker
COPY --chmod=0755 docker-mountpoints.sh /usr/local/bin/docker
COPY --from=gog /usr/local/bin/gog /usr/local/bin/gog
# ClawDesk bridge: OpenClaw CLI steps without an RPC (MCP sign-in), for the panel, on loopback.
COPY --chmod=0644 clawdesk-bridge.mjs clawdesk-backup.mjs clawdesk-teams.mjs clawdesk-oauth.mjs clawdesk-audio.mjs clawdesk-agent-folders.mjs clawdesk-file-sync.mjs clawdesk-video.mjs clawdesk-claude.mjs clawdesk-skills.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-memory.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-storage.mjs /usr/local/lib/
COPY --chmod=0755 gateway-start.sh /usr/local/bin/clawdesk-gateway-start
# ClawDesk's own skills (Figma), loaded through skills.load.extraDirs when the owner connects them.
COPY skills /usr/local/share/clawdesk/skills
COPY plugins /usr/local/share/clawdesk/plugins
# Mount points of the panel's and FreeLLMAPI's volumes (backups read them). Owned by node: when the
# Gateway is the first to mount a fresh volume, Docker gives the volume this ownership, and the
# panel (node) must still be able to write its data there.
USER root
# Claude Code for OpenClaw's "Claude CLI" route: the only way Anthropic lets a Claude plan (Pro/Max)
# drive other programs. Pinned; npm here skips install scripts, so the native binary is unpacked
# by hand. Updates come with a new ClawDesk image, never by itself (DISABLE_AUTOUPDATER).
ARG CLAUDE_CODE_VERSION=2.1.301
RUN npm install -g --no-fund --no-audit @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}   && node /usr/local/lib/node_modules/@anthropic-ai/claude-code/install.cjs   && claude --version   && npm cache clean --force
# OpenMP is required by the managed llama.cpp CPU server used for local memory embeddings.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /var/lib/clawdesk-sources/panel /var/lib/clawdesk-sources/freellmapi && chown -R node:node /var/lib/clawdesk-sources
USER node
ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/clawdesk-gateway-start"]
