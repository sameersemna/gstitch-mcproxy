FROM node:22-alpine

RUN addgroup -S mcproxy && adduser -S mcproxy -G mcproxy

WORKDIR /app

COPY index.js ./
COPY INSTRUCTIONS.md ./

RUN mkdir -p logs && chown -R mcproxy:mcproxy /app

USER mcproxy

ENV MCP_SERVER_PORT=8787
ENV MCP_SERVER_HOST=0.0.0.0
ENV LOG_ENABLED=false
ENV LOG_LEVEL=info
ENV LOG_DIR=logs
ENV METRICS_ENABLED=true
ENV LOG_VIEWER_ENABLED=true

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8787/health || exit 1

CMD ["node", "index.js"]
