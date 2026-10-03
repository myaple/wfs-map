#!/usr/bin/env bash
set -euo pipefail
image=${1:?Pass the preloaded application image tag}
network=wfs-offline-test
cleanup() {
  docker rm -f wfs-api-test wfs-db-test >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$network" >/dev/null
docker run -d --pull=never --network "$network" --name wfs-db-test --network-alias database \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=workspaces_test postgis/postgis:16-3.4 >/dev/null
ready=false
for attempt in {1..60}; do
  if docker exec wfs-db-test pg_isready -U postgres -d workspaces_test >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
test "$ready" = true
docker run -d --pull=never --network "$network" --name wfs-api-test \
  -e DATABASE_URL=postgres://postgres:postgres@database:5432/workspaces_test \
  -e USER_ID_HEADER=x-analyst-id "$image" >/dev/null
address=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' wfs-api-test)
base="http://$address:8787"
ready=false
for attempt in {1..60}; do
  if curl --noproxy '*' -fsS "$base/health" >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if test "$ready" != true; then docker logs wfs-api-test; exit 1; fi
test "$(docker network inspect -f '{{.Internal}}' "$network")" = true
curl --noproxy '*' -fsS "$base/" | rg -q 'WFS'
test "$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$base/api/me")" = 401
test "$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' -H 'x-user-id: wrong' "$base/api/me")" = 401
curl --noproxy '*' -fsS -H 'x-analyst-id: offline-analyst' "$base/api/me" | rg -q 'offline-analyst'
curl --noproxy '*' -fsS -H 'x-analyst-id: offline-analyst' "$base/api/analyses" | rg -q '^\[\]$'
curl --noproxy '*' -fsS -H 'x-analyst-id: offline-analyst' "$base/api/openapi.json" | rg -q 'WFS analysis workspaces'
docker exec wfs-db-test psql -U postgres -d workspaces_test -tAc "SELECT extname FROM pg_extension WHERE extname='postgis'" | rg -q '^postgis$'
echo 'Rust/static UI/PostGIS runtime passed on an internal Docker network.'
