# Instant Polish API server: Express plus the Python/PyTorch pipeline.
#
# Build from the REPOSITORY ROOT. The server imports two shared modules from
# src/ (src/audio/presets.js and src/auth/plans.js) and reads the referenceEQ
# stage's curves from data/reference_curves/, so the build context has to
# contain all three:
#
#   docker build -f server/Dockerfile -t wavely-server .
#   docker run -p 127.0.0.1:3001:3001 --env-file server/.env -v wavely-models:/models wavely-server
#
# The root .dockerignore whitelists what the image needs, so the client app,
# test data and mockups never reach the build.
#
# Model weights (DeepFilterNet3, Demucs, ...) are NOT baked in:
# each downloads on first use into /models. Mount a persistent volume there or
# every redeploy downloads them again. See docs/deployment.md.
#
# CPU PyTorch by default. For an NVIDIA host, build with
#   --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu118
# (and run the container with GPU access).
#
# Every dependency installs from a prebuilt wheel or npm tarball, so the build
# needs no apt-get and no compiler. ffmpeg comes from @ffmpeg-installer.

ARG PYTHON_VERSION=3.11
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS node

# ── Python environment ──────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim-bookworm AS python-deps

ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu

RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# torch first, from the CPU (or CUDA) index: requirements.txt pins
# torch==2.0.1, which 2.0.1+cpu satisfies, so the rest never pulls the
# multi-GB CUDA build from PyPI. numpy stays on 1.x: torch 2.0.1 was built
# against it and fails to import under NumPy 2.
RUN pip install --upgrade pip wheel setuptools \
 && pip install --index-url "$TORCH_INDEX_URL" torch==2.0.1 torchaudio==2.0.2

COPY server/requirements.txt /tmp/requirements.txt
RUN printf 'numpy<2\ntorch==2.0.1\ntorchaudio==2.0.2\n' > /tmp/constraints.txt \
 && pip install -r /tmp/requirements.txt -c /tmp/constraints.txt

# ── Node dependencies ───────────────────────────────────────────────────────
FROM node AS node-deps

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim-bookworm

# Node is a single binary; npm is not needed at runtime.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=python-deps /opt/venv /opt/venv

WORKDIR /app
COPY --from=node-deps /app/server/node_modules server/node_modules
COPY src/audio/presets.js src/audio/presets.js
COPY src/auth/plans.js    src/auth/plans.js
COPY data/reference_curves data/reference_curves
COPY server server

# Model caches all live under /models (one volume):
#   DeepFilterNet3 → $XDG_CACHE_HOME/DeepFilterNet
#   Demucs, torch.hub → $TORCH_HOME
#   Hugging Face (LavaSR, AP-BWE) → $HF_HOME
#   numba's compiled kernels → $NUMBA_CACHE_DIR
# HOST: index.js listens on 127.0.0.1 by default, which inside a container is
# unreachable from the proxy (Traefik runs in another container) — while the
# HEALTHCHECK below, probing 127.0.0.1 from inside, still passes. So the image
# listens on every interface, and the PORT must only ever be reached through
# the proxy: never publish it on the host (no Coolify "Ports Mappings"), or a
# client can forge X-Forwarded-For and reset every per-IP rate limit.
ENV PATH=/opt/venv/bin:$PATH \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    SEPARATION_PYTHON=/opt/venv/bin/python \
    XDG_CACHE_HOME=/models/cache \
    TORCH_HOME=/models/torch \
    HF_HOME=/models/huggingface \
    NUMBA_CACHE_DIR=/models/numba \
    PYTHONUNBUFFERED=1

# Non-root. server/ stays writable for uploads/ and pipeline logs.
RUN useradd --create-home --uid 1000 app \
 && mkdir -p /models server/uploads \
 && chown -R app:app /models /app/server
USER app

VOLUME /models
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

WORKDIR /app/server
# No --env-file: the platform injects the environment. index.js exits on
# SIGTERM, which node as PID 1 would otherwise ignore.
CMD ["node", "--experimental-wasm-modules", "index.js"]
