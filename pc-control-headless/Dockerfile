# Build from the REPO ROOT so shared libs are included (GUI untouched):
#   docker build -f pc-control-headless/Dockerfile -t pc-control-headless .
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -u 10001 pcctl

WORKDIR /app

# Single prod install at /app: Node resolves shared lib/* requires upward,
# so one node_modules covers both trees. Lockfile pins exact versions.
# --ignore-scripts: prod deps are pure JS; no build scripts should ever run.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
  && npm cache clean --force

# Shared runtime (read-only reuse). Desktop/Electron files are NOT copied.
COPY lib/ ./lib/
COPY tools/ ./tools/
COPY relay-server/scopes.js ./relay-server/scopes.js
COPY pc-control-headless/ ./pc-control-headless/

RUN chown -R pcctl:pcctl /app
USER pcctl

ENV MCP_CONFIG_PATH=/data/config.json
ENV NODE_ENV=production
VOLUME ["/data"]
EXPOSE 3000

# /health requires Bearer auth: compose must set HEALTH_KEY to the api_key.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health',{headers:{Authorization:'Bearer '+process.env.HEALTH_KEY}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

WORKDIR /app/pc-control-headless
# 0.0.0.0 is correct INSIDE the container; publish selectively via compose
# (127.0.0.1:3000:3000) or sit behind a TLS reverse proxy.
CMD ["node", "bin/pc-control.js", "--mode=http", "--host", "0.0.0.0", "--port", "3000"]
