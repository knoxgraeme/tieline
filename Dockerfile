# syntax=docker/dockerfile:1
# ----------------------------------------------------------------------------
# Portable, deterministic image for the MCP server — deploy on plain Fly,
# Railway, Render, Docker, or your own box, independent of any managed builder.
#
# Two stages so the runtime image ships ONLY prod deps (sdk/express/postgres/zod
# ~28MB) + the compiled dist — no TypeScript, no devDeps, no native ONNX runtime.
# Final image is ~150MB (base node:slim) and boots in well under a second.
#
# Build:   docker build -t tieline .
# Run:     docker run --rm -p 3000:3000 -e DATABASE_URL=... -e EMBEDDING_PROVIDER=openai tieline
# Health:  GET http://localhost:3000/health   MCP: POST http://localhost:3000/mcp
# ----------------------------------------------------------------------------

# ---- build stage: install everything + compile TypeScript -------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Only the manifest first, so `npm ci` is cached until deps actually change.
COPY package.json package-lock.json ./
RUN npm ci
# Compile TypeScript (build), then bundle the opt-in MCP review-app UI (build:app,
# esbuild) into dist/authoring/review-ui/app.html. Without build:app that file is
# never generated, so a container run with ENABLE_REVIEW_APP=true would ENOENT on
# the ui:// resource. Both need the devDeps installed above; the runtime stage
# copies the whole dist, so the generated HTML rides along.
COPY tsconfig.json ./
COPY src ./src
# scripts/ is needed by the postbuild UI bundle (scripts/build-app-ui.mjs); tsc
# ignores it (excluded in tsconfig). Build-stage only — not in the runtime image.
COPY scripts ./scripts
# `npm run build` = tsc, then a postbuild that bundles the review-app UI into
# dist/authoring/review-ui/app.html (devDeps present here via `npm ci`). The
# bundle step skips gracefully if esbuild is ever absent, so this never breaks.
RUN npm run build

# ---- runtime stage: prod deps + compiled dist only --------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prod-only dependencies (drops typescript/tsx/esbuild/ext-apps devDeps).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Optional in-process `local` gte-small embedder. OFF by default to keep the
# image lean (it pulls ~400MB of native ONNX runtime). Turn on at build time:
#   docker build --build-arg WITH_LOCAL_EMBEDDER=true -t tieline .
# Otherwise set EMBEDDING_PROVIDER=openai|supabase-edge at runtime.
ARG WITH_LOCAL_EMBEDDER=false
RUN if [ "$WITH_LOCAL_EMBEDDER" = "true" ]; then \
      npm install @huggingface/transformers && npm cache clean --force; \
    fi

COPY --from=build /app/dist ./dist

ENV PORT=3000
# Writable cache dir for the optional local model download (USER node can't
# write into the root-owned node_modules).
ENV TRANSFORMERS_CACHE=/tmp/transformers-cache
EXPOSE 3000

# Drop root.
USER node

# Liveness probe against the built-in /health endpoint (Node 22 has global fetch).
# Used by docker/Railway/Render; a managed Fly host defines its own service check.
# Only meaningful in http mode: under `-e TRANSPORT=stdio` no HTTP server binds, so
# the probe short-circuits to exit 0 (healthy) instead of failing forever.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD if [ "${TRANSPORT:-http}" = "stdio" ]; then exit 0; else \
        node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; \
      fi

# Default this container to the HTTP transport (POST /mcp, GET /health). Set as a
# CMD-inline default, NOT a persistent ENV, so a managed host that spawns
# `node dist/index.js` itself over stdio is not forced into http mode. `exec`
# makes node PID 1 (clean signal handling); override at run time with
# `-e TRANSPORT=stdio`.
CMD ["sh", "-c", "exec node dist/cli.js serve --http"]
