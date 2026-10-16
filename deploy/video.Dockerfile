# syntax=docker/dockerfile:1
# Video worker: yt-dlp and ffmpeg, pinned, for studying one video link (subtitles first, the audio
# track only when a video has none). Started per job by the ClawDesk bridge in the Gateway
# container, with no mounts but its own output directory, no Docker socket and no credentials.
# It is the only part of ClawDesk that reaches a video site, and it reaches nothing else of ours.
FROM debian:bookworm-slim
ARG YT_DLP_VERSION=2026.8.19
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg python3 python3-pip \
  && pip3 install --no-cache-dir --break-system-packages "yt-dlp==${YT_DLP_VERSION}" \
  && apt-get purge -y python3-pip && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
# Never the root user, and no home the job could keep state in between runs.
RUN useradd --no-create-home --uid 65532 --shell /usr/sbin/nologin worker
USER worker
WORKDIR /out
# No cookies, no netrc, no config file: only the arguments the bridge passes.
ENTRYPOINT ["yt-dlp", "--ignore-config", "--no-cookies", "--netrc-location", "/dev/null", "--no-progress", "--no-warnings", "--socket-timeout", "30", "--retries", "2", "--no-playlist"]
