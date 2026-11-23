# syntax=docker/dockerfile:1
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HTTP_PORT=8080 \
    SMTP_PORT=25
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
# Docker lets unprivileged users bind ports < 1024 inside the container (ip_unprivileged_port_start=0),
# so port 25 works without root. On Kubernetes, listen on 2525 and map 25 → 2525 in the Service.
USER node
VOLUME ["/data"]
EXPOSE 25 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.HTTP_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.ts"]
