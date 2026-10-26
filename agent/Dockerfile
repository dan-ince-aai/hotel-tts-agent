# syntax=docker/dockerfile:1
# Adapted from https://github.com/livekit-examples/agent-starter-python
ARG PYTHON_VERSION=3.13
FROM ghcr.io/astral-sh/uv:python${PYTHON_VERSION}-bookworm-slim AS base

# Don't buffer logs, and compile bytecode at install time for a faster cold start
ENV PYTHONUNBUFFERED=1
ENV UV_COMPILE_BYTECODE=1
ENV HF_HOME=/app/.cache/huggingface

FROM base AS build

# Compilers for packages with native extensions.
RUN apt-get update && apt-get install -y gcc g++ python3-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so code-only changes reuse this layer. Once a uv.lock is committed (run
# `uv lock` where PyPI's livekit 1.8.9 can be installed), copy it too and add --locked.
COPY pyproject.toml ./
RUN mkdir -p src
RUN uv sync --no-dev

# Download model files at build time rather than on the first call
RUN uv run --module livekit.agents download-files

COPY . .

FROM base

# Run as an unprivileged user
ARG UID=10001
RUN adduser --disabled-password --gecos "" --home "/app" --shell "/sbin/nologin" --uid "${UID}" appuser
COPY --from=build --chown=appuser:appuser /app /app
WORKDIR /app
USER appuser

CMD ["uv", "run", "--no-dev", "src/agent.py", "start"]
