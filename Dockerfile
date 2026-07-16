# ── Stage 1: build the frontend ─────────────────────────────────────────────
FROM node:22-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npx vite build --logLevel error

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM python:3.12-slim

# tmux is the session engine; git/curl because most agent workflows need them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git curl procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY --from=frontend /build/dist frontend/dist

# Inside a container the port mapping is the isolation boundary, so bind all
# interfaces. State (titles, push subs, VAPID key, profiles) goes to a volume.
ENV AGENTBOARD_HOST=0.0.0.0 \
    AGENTBOARD_STATE_DIR=/data \
    AGENTBOARD_DEFAULT_CMD=bash \
    AGENTBOARD_ALLOWED_ROOTS=/workspace

VOLUME /data
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD curl -sf http://localhost:3002/api/health || exit 1

CMD ["python", "-m", "backend.main"]
