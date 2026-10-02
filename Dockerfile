FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY vendor/npm-cache-parts ./vendor/npm-cache-parts/
COPY scripts/install-offline.mjs ./scripts/
RUN --network=none node scripts/install-offline.mjs
COPY . .
RUN --network=none npm run build

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "server/server.ts"]
