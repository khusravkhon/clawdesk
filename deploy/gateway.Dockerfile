# syntax=docker/dockerfile:1
# OpenClaw Gateway + Docker CLI, so it can start sandbox containers for junior
# agents (decision 2: sandbox for every junior agent). The Gateway talks to the
# host Docker daemon through the mounted socket ("Docker-out-of-Docker").
# The version is deploy/openclaw.version; this default is kept equal to it (scripts/openclaw-version.mjs).
ARG OPENCLAW_VERSION=2026.8.35
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw

FROM docker:29-cli AS docker-cli

# Google Workspace CLI for OpenClaw's bundled gog skill (Drive/Docs/Gmail source). Pinned and checksummed.
# Downloaded with retries (fetch-verified.mjs): GitHub sometimes answers a release download with a 504 page,
# which ADD --checksum turned into a failed build; only bytes with the pinned SHA-256 are ever accepted.
FROM node:24-bookworm-slim AS gog
ARG GOG_VERSION=0.42.0
ARG GOG_SHA256=1967a962a57d689958c408dd0abc784792c3712da9d0a90650bb76ab7e3de388
COPY fetch-verified.mjs /tmp/fetch-verified.mjs
RUN node /tmp/fetch-verified.mjs https://github.com/openclaw/gogcli/releases/download/v${GOG_VERSION}/gogcli_${GOG_VERSION}_linux_amd64.tar.gz ${GOG_SHA256} /tmp/gog.tgz
RUN mkdir /tmp/gog && tar xzf /tmp/gog.tgz -C /tmp/gog && install -m 0755 /tmp/gog/gog /usr/local/bin/gog

# GitHub CLI: OpenClaw's GitHub sign-in for an agent ("Источники данных → GitHub") stores the token in a gh
# profile (`gh auth login --with-token`); without gh every approved sign-in ends in setup_failed. Pinned and checksummed.
FROM node:24-bookworm-slim AS gh
ARG GH_VERSION=2.103.0
ARG GH_SHA256=fdd768eb70f6409f80fcfa9f3a1c0adf0fc98d827ab3ce0bed2ac22762c5d786
COPY fetch-verified.mjs /tmp/fetch-verified.mjs
RUN node /tmp/fetch-verified.mjs https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz ${GH_SHA256} /tmp/gh.tgz
RUN mkdir /tmp/gh && tar xzf /tmp/gh.tgz -C /tmp/gh && install -m 0755 /tmp/gh/gh_${GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/gh

FROM ${OPENCLAW_IMAGE}:${OPENCLAW_VERSION}
ARG OPENCLAW_VERSION
# What this image runs, for the panel and for init.sh (deploy/scripts/openclaw-choice.sh).
LABEL org.clawdesk.openclaw-version=${OPENCLAW_VERSION}
# The real CLI sits behind a wrapper that keeps agent workspaces owned by the Gateway
# user (see docker-mountpoints.sh); OpenClaw keeps calling plain `docker`.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/libexec/docker
# BuildKit for the OpenClaw update from the panel (clawdesk-openclaw-update.mjs builds this image again).
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx
COPY --chmod=0755 docker-mountpoints.sh /usr/local/bin/docker
COPY --from=gog /usr/local/bin/gog /usr/local/bin/gog
COPY --from=gh /usr/local/bin/gh /usr/local/bin/gh
# ClawDesk bridge: OpenClaw CLI steps without an RPC (MCP sign-in), for the panel, on loopback.
COPY --chmod=0644 clawdesk-bridge.mjs clawdesk-backup.mjs clawdesk-teams.mjs clawdesk-oauth.mjs clawdesk-audio.mjs clawdesk-agent-folders.mjs clawdesk-file-sync.mjs clawdesk-video.mjs clawdesk-claude.mjs clawdesk-skills.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-memory.mjs openclaw.supported clawdesk-openclaw-update.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-plugin-repair.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-storage.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-project-folders.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-project-builder.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-project-checks.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-project-load.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-project-work.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-requests-spool.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-project-github.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-google-docs.mjs clawdesk-owner-files.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-project-transfer.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-capabilities.mjs /usr/local/lib/
COPY project-templates /usr/local/lib/project-templates
COPY --chmod=0644 clawdesk-shared-folder.mjs /usr/local/lib/
COPY --chmod=0644 clawdesk-containers.mjs /usr/local/lib/
COPY --chmod=0755 gateway-start.sh /usr/local/bin/clawdesk-gateway-start
# ClawDesk's own skills (Figma), loaded through skills.load.extraDirs when the owner connects them.
COPY skills /usr/local/share/clawdesk/skills
COPY plugins /usr/local/share/clawdesk/plugins
# Mount points of the panel's and FreeLLMAPI's volumes (backups read them). Owned by node: when the
# Gateway is the first to mount a fresh volume, Docker gives the volume this ownership, and the
# panel (node) must still be able to write its data there.
USER root
COPY --chmod=0644 clawdesk-startup-migration-fix.mjs /usr/local/lib/
# The OpenClaw this image runs (not deploy/openclaw.version: the panel may build another verified one).
RUN echo "$OPENCLAW_VERSION" > /usr/local/lib/openclaw.version && chmod 0644 /usr/local/lib/openclaw.version
# Exclude failed maintenance stores from reconciliation; retain upstream deletion fences.
RUN node /usr/local/lib/clawdesk-startup-migration-fix.mjs
# Claude Code for OpenClaw's "Claude CLI" route: the only way Anthropic lets a Claude plan (Pro/Max)
# drive other programs. Pinned; npm here skips install scripts, so the native binary is unpacked
# by hand. Updates come with a new ClawDesk image, never by itself (DISABLE_AUTOUPDATER).
ARG CLAUDE_CODE_VERSION=2.1.301
RUN npm install -g --no-fund --no-audit @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}   && node /usr/local/lib/node_modules/@anthropic-ai/claude-code/install.cjs   && claude --version   && npm cache clean --force
# OpenMP is required by the managed llama.cpp CPU server used for local memory embeddings.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /var/lib/clawdesk-sources/panel /var/lib/clawdesk-sources/freellmapi && chown -R node:node /var/lib/clawdesk-sources
# This image's own build files: the panel builds it again for another verified OpenClaw from them
# (gateway.Dockerfile.dockerignore lets only these in — never .env or data).
COPY . /usr/local/share/clawdesk/gateway-build
USER node
ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/clawdesk-gateway-start"]
