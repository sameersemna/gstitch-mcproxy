# syntax=docker/dockerfile:1
FROM node:22-alpine

# The project has no runtime dependencies, so there is no install step and no node_modules.
# `package.json` is copied anyway so `npm pkg get` and tooling work, and so a future
# dependency would not need a Dockerfile change.
WORKDIR /app

COPY package.json ./
COPY index.js ./
COPY src ./src
COPY INSTRUCTIONS.md ./

# Run unprivileged. `node` is the user the official image already provides.
RUN mkdir -p /app/logs && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV MCP_SERVER_PORT=8787
# Container deployments still need LAN reachability (owner decision 1); publish the port on
# loopback only if you do not want that.
ENV MCP_SERVER_HOST=0.0.0.0
ENV LOG_ENABLED=false
ENV LOG_LEVEL=info
ENV LOG_DIR=logs
ENV METRICS_ENABLED=true

EXPOSE 8787

# Use the bundled `node` for the healthcheck: it is guaranteed present, and it exercises the real
# health path including the JSON body, unlike a bare TCP or header probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_SERVER_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM

CMD ["node", "index.js"]
