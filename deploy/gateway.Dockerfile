# syntax=docker/dockerfile:1
# OpenClaw Gateway + Docker CLI, so it can start sandbox containers for junior
# agents (decision 2: sandbox for every junior agent). The Gateway talks to the
# host Docker daemon through the mounted socket ("Docker-out-of-Docker").
ARG OPENCLAW_VERSION=2026.8.1
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw

FROM docker:29-cli AS docker-cli

FROM ${OPENCLAW_IMAGE}:${OPENCLAW_VERSION}
# The real CLI sits behind a wrapper that keeps agent workspaces owned by the Gateway
# user (see docker-mountpoints.sh); OpenClaw keeps calling plain `docker`.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/libexec/docker
COPY --chmod=0755 docker-mountpoints.sh /usr/local/bin/docker
