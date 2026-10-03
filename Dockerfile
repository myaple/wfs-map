FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY vendor/npm-cache-parts ./vendor/npm-cache-parts/
COPY scripts/install-offline.mjs ./scripts/
RUN --network=none node scripts/install-offline.mjs
COPY backend/Cargo.lock ./backend/
COPY backend/vendor-parts ./backend/vendor-parts/
COPY scripts/install-rust-offline.mjs ./scripts/
RUN --network=none node scripts/install-rust-offline.mjs
COPY . .
RUN --network=none npm run build && node scripts/collect-rust-licenses.mjs

FROM rust:1.90-bookworm AS rust-build
WORKDIR /app/backend
COPY --from=build /app/backend/vendor ./vendor
COPY backend/.cargo ./.cargo
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src ./src
COPY backend/migrations ./migrations
# libpq and OpenSSL are built from the vendored sources and linked statically.
RUN --network=none cargo build --release --locked --offline

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=rust-build /app/backend/target/release/wfs-workspaces ./wfs-workspaces
COPY --from=build /app/dist ./dist
COPY --from=build /app/backend/licenses ./licenses/rust
COPY vendor/licenses ./licenses/npm
COPY LICENSE ./licenses/LICENSE
ENV BIND=0.0.0.0:8787 ASSET_DIR=/app/dist AUTH_MODE=proxy USER_ID_HEADER=x-user-id
USER 10001:10001
EXPOSE 8787
CMD ["/app/wfs-workspaces"]
