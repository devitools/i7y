FROM node:22-alpine AS frontend
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci
COPY apps/web/index.html apps/web/vite.config.js ./apps/web/
COPY apps/web/src ./apps/web/src
COPY docs/install-agent.*.md ./docs/
RUN npm run build
FROM alpine:3.21
WORKDIR /pb
COPY apps/backend/bootstrap.sh /pb/bootstrap.sh
COPY apps/backend/migrations /pb/migrations
COPY apps/backend/hooks /pb/hooks
COPY --from=frontend /app/apps/web/dist /pb/public
ENTRYPOINT ["/bin/sh", "/pb/bootstrap.sh"]
CMD ["serve", "--http=0.0.0.0:8090", "--dir=/pb/pb_data", "--migrationsDir=/pb/migrations", "--hooksDir=/pb/hooks", "--publicDir=/pb/public", "--automigrate=true", "--hooksWatch=false"]
