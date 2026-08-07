# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Marker (PDF → Markdown, torch + surya models) adds ~3-5GB. Opt in only if an
# agent group needs local PDF-to-Markdown conversion. See the Marker section
# below for why it's a separate opt-in rather than always-on.
ARG INSTALL_MARKER=false

# Pandoc + Typst (Markdown → Typst → PDF rendering, e.g. for the `dossier`
# skill). Opt in only if an agent group renders Markdown to a styled PDF
# locally. See the Typst section below.
ARG INSTALL_TYPST=false

# Pin versions for reproducibility. Bump deliberately — unpinned installs mean
# every rebuild silently picks up the latest and can break in lockstep across
# all users. The global Node CLIs (claude-code, agent-browser) are
# pinned in cli-tools.json so a skill can add one with a json-merge; Bun (the
# runtime) is pinned here because it installs from a different source.
ARG BUN_VERSION=1.3.12

# uv + marker-pdf: only fetched/installed when INSTALL_MARKER=true (see below),
# but declared here with the other version pins per convention.
ARG UV_VERSION=0.12.1
ARG MARKER_PDF_VERSION=2.0.0

# typst: only fetched/installed when INSTALL_TYPST=true (see below).
ARG TYPST_VERSION=0.15.1

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        tini \
        unzip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && if [ "$INSTALL_MARKER" = "true" ]; then \
        apt-get install -y --no-install-recommends build-essential \
            zlib1g-dev libjpeg-dev libopenjp2-7-dev libtiff-dev \
            libfreetype6-dev liblcms2-dev libwebp-dev libharfbuzz-dev \
            libfribidi-dev libxcb1-dev; \
       fi \
    && if [ "$INSTALL_TYPST" = "true" ]; then \
        apt-get install -y --no-install-recommends pandoc xz-utils; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips claude-code's native-binary postinstall and agent-browser's
# bin chmod — the agent then crashes at runtime with "native binary not
# installed". Keep this in lockstep with package.json's `packageManager`.
ARG PNPM_VERSION=10.33.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Global Node CLIs the agent invokes at runtime live in cli-tools.json so a
# skill can add one with a json-merge instead of editing this Dockerfile.
# install-cli-tools.sh installs each via pnpm (pinned), writing the per-tool
# only-built-dependencies opt-ins it reads from the manifest.
COPY cli-tools.json install-cli-tools.sh /tmp/
RUN --mount=type=cache,target=/root/.cache/pnpm \
    sh /tmp/install-cli-tools.sh /tmp/cli-tools.json

# ---- Marker (PDF → Markdown), opt-in -----------------------------------------
# Heavy ML tool (torch + surya models) — off by default, like the CJK fonts
# above. Installed via uv rather than system pip/apt: this image ships no
# python3 at all, and Debian's would be PEP 668 "externally managed" anyway.
# uv manages its own Python + venv, so no system python3 package is needed.
#
# uv itself installs from a version-pinned release URL (not the rolling
# astral.sh/uv/install.sh script) for the same reproducibility reason BUN_VERSION
# is pinned above. UV_UNMANAGED_INSTALL skips the self-updater and shell-rc
# edits, neither of which make sense baked into an image.
#
# Model weights are NOT baked in here — that would need a network call at
# build time pinned to a fixed model revision, and would bloat every image
# whether or not a group actually uses Marker. They download on first real
# conversion instead, into $HOME/.cache/huggingface. Mount that path from the
# host (additionalMounts on the agent group's container config) so it
# survives container restarts (`--rm` wipes anything not mounted) instead of
# re-downloading every time.
#
# build-essential + Pillow's external-library dev headers (added to the apt
# block above, same flag): uv provisions its own (unpinned, latest) Python
# for the tool venv, which can land on a version fresh enough that some deps
# have no prebuilt wheel yet — Pillow hit exactly that and had to compile
# from source. It failed once for missing zlib, then again for missing jpeg
# (both "required" per Pillow's own build check); the rest of the list here
# is Pillow's documented "build with all optional features" set, added
# preemptively so a third format library doesn't cost another multi-GB,
# several-minute round-trip through the unrelated torch/CUDA downloads below.
ENV UV_TOOL_DIR=/opt/uv-tools
ENV UV_TOOL_BIN_DIR=/usr/local/bin
RUN if [ "$INSTALL_MARKER" = "true" ] || [ "$INSTALL_TYPST" = "true" ]; then \
        curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-installer.sh" \
            | env UV_INSTALL_DIR=/usr/local/bin UV_UNMANAGED_INSTALL=1 sh; \
    fi \
    && if [ "$INSTALL_MARKER" = "true" ]; then \
        uv tool install "marker-pdf==${MARKER_PDF_VERSION}" && \
        chmod -R a+rX /opt/uv-tools; \
    fi

# ---- Typst (Markdown → PDF rendering), opt-in --------------------------------
# Pairs with pandoc (apt block above) and uv (installed above, shared with
# Marker) for skills that render Markdown to a styled PDF locally — e.g. the
# `dossier` skill's bundled renderer. No apt package exists for typst on
# Debian, so it's fetched as a pinned, statically-linked release binary from
# GitHub instead (musl build; runs fine on this glibc base — same reasoning
# as fetching Bun's official installer above rather than an apt/npm package).
# uname -m rather than Docker's TARGETARCH: this RUN executes on the build
# platform, not the target platform, so it stays correct even for a
# cross-arch build.
RUN if [ "$INSTALL_TYPST" = "true" ]; then \
        ARCH="$(uname -m)" && \
        case "$ARCH" in \
            x86_64) TYPST_ARCH=x86_64-unknown-linux-musl ;; \
            aarch64) TYPST_ARCH=aarch64-unknown-linux-musl ;; \
            *) echo "Unsupported architecture for typst: $ARCH" >&2; exit 1 ;; \
        esac && \
        curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${TYPST_ARCH}.tar.xz" \
            | tar -xJ -C /tmp && \
        install -m 0755 "/tmp/typst-${TYPST_ARCH}/typst" /usr/local/bin/typst && \
        rm -rf "/tmp/typst-${TYPST_ARCH}"; \
    fi

# ---- ncl CLI wrapper ----------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/ncl.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/ncl.ts "$@"\n' > /usr/local/bin/ncl && \
    chmod +x /usr/local/bin/ncl

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

# Drop setuid-root from the binaries Debian ships (mount, su, passwd, ...). The
# agent runs unprivileged and needs none of them.
RUN find / -xdev -perm -4000 -type f -exec chmod u-s {} + || true

USER node
WORKDIR /workspace/group

# Only applies to a bare `docker run` — the host spawn overrides ENTRYPOINT and
# passes --init instead (see hardeningArgs in src/container-runner.ts).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

# ---- Provenance labels -------------------------------------------------------
# LAST on purpose. An ARG invalidates every layer below it, so declaring these
# up with the other build-args would make an otherwise-cached rebuild redo
# `bun install` and the pnpm global CLIs on every existing install, for two
# pieces of metadata. Labels have no filesystem effect, so they cost nothing here.
#
# Which lockfile the baked /app/node_modules came from: /app/src is mounted from
# the host checkout at every spawn, so an image and a checkout whose lockfiles
# disagree fail as a missing module inside a `--rm` container with no logs.
# container/pull.sh checks this before retagging. build.sh passes it; a bare
# `docker build` leaves it empty, which the pull path treats as unverifiable.
#
# image-source defaults to `local` so anything built from this file is honest
# unless its builder says otherwise — the retag cannot forge it after the fact.
ARG AGENT_RUNNER_LOCK_SHA256=
LABEL dev.nanoclaw.agent-runner-lock-sha256="${AGENT_RUNNER_LOCK_SHA256}"
ARG IMAGE_SOURCE=local
LABEL dev.nanoclaw.image-source="${IMAGE_SOURCE}"
