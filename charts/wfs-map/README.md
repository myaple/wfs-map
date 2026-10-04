# WFS Map Helm chart

Deploys the production image as a Deployment serving **both the UI and API**
on port 8787, a Service, and an optional Ingress for the entire app.
Requires Helm 3+ and Kubernetes 1.25+. There are **no chart dependencies** and
no built-in PostgreSQL, PostGIS, operator, database volume, or database workload.
Use your existing PostgreSQL/PostGIS or CNPG installation.

## Install

### Extract from the application image

Every production image contains this complete chart at `/app/charts/wfs-map`,
including templates, default values, the values schema, examples and this
README. Transfer the application image to the disconnected environment and
extract the chart without starting the app or connecting to PostgreSQL:

```sh
# After docker load (or with your mirrored image tag):
image=ghcr.io/myaple/wfs-map:latest
container_id=$(docker create --pull=never "$image")
docker cp "$container_id:/app/charts/wfs-map" ./wfs-map-chart
docker rm "$container_id"
helm upgrade --install maps ./wfs-map-chart \
  --namespace analytics --create-namespace \
  --set externalDatabase.existingSecret=analytics-db-app \
  --set externalDatabase.existingSecretUrlKey=uri \
  -f site-values.yaml
```

Use your transferred/mirrored application tag through `image.*` values and
ensure the cluster can load that image. The chart has no dependencies to fetch;
no repository checkout or separate chart download is needed. Helm runs on your
deployment host. PostgreSQL/PostGIS and the CNPG operator remain cluster-managed.

### Install from a repository checkout

Create the namespace and supply an existing database Secret in that namespace.
For a CNPG Cluster called `analytics-db`, its generated application Secret is
usually `analytics-db-app`, with the full connection URI in `uri`.

```sh
helm upgrade --install maps ./charts/wfs-map \
  --namespace analytics --create-namespace \
  --set image.tag=sha-512b97b \
  --set externalDatabase.existingSecret=analytics-db-app \
  --set externalDatabase.existingSecretUrlKey=uri \
  -f site-values.yaml
```

The default image is `ghcr.io/myaple/wfs-map:latest`. Pin the SHA tag produced
by this repository's container workflow or set `image.digest` in production.
Override `image.registry/repository` or `global.imageRegistry` for your internal
registry; `image.pullSecrets` and `global.imagePullSecrets` accept Secret names
or objects with a `name` field. No dependency downloads are needed to install
or package this chart.

## Database connection

Select one of these modes:

| Mode | Values |
| --- | --- |
| Existing complete URI Secret (default) | `externalDatabase.existingSecret` and `existingSecretUrlKey` (default `uri`) |
| Existing password Secret | Set `existingSecretUrlKey: ""`, `existingSecretPasswordKey: password`, and configure `host`, `port`, `username`, `database`, `sslMode` |
| Inline complete URI | Set `existingSecret: ""` and `url: postgresql://…` |
| Inline connection fields | Set `existingSecret: ""`, `host`, `port`, `username`, `database`, `password`, `sslMode` |

The default expects a pre-existing `wfs-map-database` Secret with key `uri`.
Secret names can contain Helm templates such as `"{{ .Release.Name }}-db-app"`.
All referenced Secrets must exist in the application's namespace. The chart
does not query live Secrets or create credentials when using the URI Secret mode.
Conflicting modes, absent connection configuration and invalid values fail at render time.

Field-based connections pass the password separately through libpq's
`PGPASSWORD`, preserving punctuation, spaces, quotes and backslashes.
For complete URIs, percent-encode credentials yourself. Inline values are
rendered into a Kubernetes Secret, never the application ConfigMap, but are
also present in Helm's release history; use an existing Secret or ExternalSecret
for operational credentials.

`externalDatabase.parameters` adds libpq URI query parameters. For example:

```yaml
externalDatabase:
  existingSecret: analytics-credentials
  existingSecretUrlKey: ""
  existingSecretPasswordKey: password
  host: analytics-db-rw
  port: 5432
  username: wfs
  database: wfs
  sslMode: verify-full
  parameters:
    sslrootcert: /etc/postgres/ca.crt
extraVolumes:
  - name: postgres-ca
    secret:
      secretName: analytics-db-ca
extraVolumeMounts:
  - name: postgres-ca
    mountPath: /etc/postgres
    readOnly: true
```

The database must contain the PostGIS extension binaries. Enable `postgis`
in the application database before startup, or grant the application role
permission to create it. The application role needs DDL privileges for its
table migrations. The app runs migrations itself, guarded by a database
advisory lock so replicas can start together. Each replica has a pool of up
to eight connections; size PostgreSQL/PgBouncer for your replica limits.

The app starts only after connecting to its database and applying migrations.
There is no chart-managed migration or wait-for-database Job: missing Secrets
or a database still bootstrapping will keep the pod pending/restarting until
available. Startup probes allow a long initialization period. `/health`
reports process availability after startup; it does not check ongoing database
connectivity.

## CNPG and extra resources

`extraResources` accepts a list of Kubernetes objects or YAML strings. Both are
evaluated using Helm `tpl` with the chart's root context. You can supply CNPG
`Cluster`, `Database`, `Pooler`, ExternalSecret, certificates, PVCs, or other
resources. The chart installs no CRDs or operators; install those first.
Set namespaces explicitly on extra resources where needed.

An example creating a CNPG Cluster with PostGIS pre-enabled:

```sh
helm upgrade --install maps ./charts/wfs-map \
  --namespace analytics --create-namespace \
  -f charts/wfs-map/examples/cnpg.yaml -f site-values.yaml
```

[examples/cnpg.yaml](examples/cnpg.yaml) connects to the operator-generated
`<release>-db-app` Secret and bootstraps PostGIS with a superuser SQL statement.
Choose a compatible PostGIS operand image for your CNPG version.
See the official [PostGIS](https://cloudnative-pg.io/docs/1.28/postgis/) and
[application connection](https://cloudnative-pg.io/docs/1.28/applications/) documentation.
The CNPG example keeps its data-bearing Cluster on Helm uninstall using
`helm.sh/resource-policy: keep`. Retained resources require manual lifecycle
management, including ownership decisions before a reinstall. Prefer an
independently managed CNPG release for long-lived shared infrastructure.
Extra resources without the keep annotation are owned and removed by Helm.

Only trusted operators should edit templated values; `tpl` evaluates Helm
expressions with the full chart context.

## Ingress and identity

`ingress.enabled` routes the whole application, including `/api`, through the
same Service and origin. Set `className`, controller-specific `annotations`,
`hosts[].paths`, `tls`, and optionally raw `extraRules`. Use a root `/` Prefix
path without rewriting; subpath hosting is not supported by the app.
TLS Secrets are supplied externally (or via `extraResources`/cert-manager).

The default `app.auth.mode: proxy` requires a trusted authentication gateway
to authenticate each user and **replace** `app.auth.userIdHeader` (default
`x-user-id`) with that user's stable identity. Configure authentication in
your ingress/controller or a gateway sidecar. The chart's Ingress does not
implement authentication itself. Restrict direct access to the Service to
the gateway; `networkPolicy` supports your namespace/pod/IP selectors.
Default `ClusterIP` alone does not enforce that boundary.

[examples/external-postgres.yaml](examples/external-postgres.yaml) includes TLS,
nginx external-auth annotations, a PDB, resources and a NetworkPolicy. Replace
the auth URLs, hostname, TLS Secret and selectors with your cluster's values.
Verify your controller's auth-header behavior and ensure a client-supplied
identity header cannot reach the app unchanged. For another gateway, use its
annotations and identity claim/header. For a sidecar, add its named port and set
`service.targetPort` to that port; probes still target the app's `http` port.

`app.auth.mode: development` gives all visitors the single
`app.auth.developmentUser` identity and is for local testing only.

## Configuration reference

All supported defaults and inline guidance are in [values.yaml](values.yaml).
The JSON schema catches unknown top-level/structured chart settings, wrong
types, ports, enum values and invalid image digests while leaving native
Kubernetes objects extensible.

| Area | Values |
| --- | --- |
| Naming and metadata | `nameOverride`, `fullnameOverride`, `namespaceOverride`, `commonLabels`, `commonAnnotations`, deployment/pod/service/ingress/ServiceAccount metadata |
| Image | `image.*`, `global.imageRegistry`, `global.imagePullSecrets` |
| Replicas and rollout | `replicaCount`, `revisionHistoryLimit`, `updateStrategy`, `minReadySeconds` |
| Runtime | `app.containerPort`, `bindAddress`, `assetDir`, `auth.*`, `banner.text/background`, `extraConfig` |
| Database | `externalDatabase.*`, existing URI/password Secrets, TLS mode and libpq parameters |
| Security | `podSecurityContext`, `containerSecurityContext`, `serviceAccount.*`, `automountServiceAccountToken` |
| Container | `resources`, `command`, `args`, `workingDir`, `lifecycleHooks`, `gracefulShutdown`, `terminationGracePeriodSeconds` |
| Health | `startupProbe`, `readinessProbe`, `livenessProbe`, including native HTTP/TCP/exec/gRPC probe settings |
| Environment | `extraEnvVars`, `extraEnvVarsCM`, `extraEnvVarsSecret`, `extraEnvFrom` |
| Storage and additional containers | `extraVolumes`, `extraVolumeMounts`, `initContainers`, `sidecars`, `extraContainerPorts` |
| Scheduling | `nodeSelector`, `affinity`, `tolerations`, `topologySpreadConstraints`, `priorityClassName`, `runtimeClassName`, `schedulerName` |
| Pod networking | `hostAliases`, `hostNetwork`, `dnsPolicy`, `dnsConfig`, `enableServiceLinks` |
| Service | Type, ports, target/node ports, ClusterIP, load balancer options, traffic policies, session affinity, IP families, extra ports |
| Ingress | `enabled`, `className`, labels/annotations, multiple hosts/paths, TLS and extra rules |
| Scaling and disruption | `autoscaling.*` (CPU/memory/custom metrics and behavior), `pdb.*` |
| Network isolation | `networkPolicy.enabled/ingress/egress`, labels/annotations |
| Arbitrary resources | `extraResources` |

Security defaults match the image's UID/GID 10001, prohibit privilege
escalation, drop all capabilities, apply RuntimeDefault seccomp, and use a
read-only root filesystem. Set either context's `enabled: false` to remove
it completely, or set individual fields to `null` to remove merged defaults,
for example `podSecurityContext.runAsUser: null` on OpenShift. Writable paths
can use `emptyDir`, projected Secrets/ConfigMaps, CSI volumes or existing PVCs
through the extra volume values; new PVCs can be declared in `extraResources`.
Application analyses are persisted in PostgreSQL; CSV datasets stay in the
browser, so the app does not require a persistent application volume.

Native objects in the extra environment, volume, container, affinity,
topology, ingress and NetworkPolicy values are templated. Kubernetes list
values are replaced, not appended, when passing later values files. Remove
the default `httpGet` with `httpGet: null` when selecting another probe action.
`extraEnvVars` overrides same-named entries from `envFrom`; source order is
managed ConfigMap, extra ConfigMap, extra Secret, then `extraEnvFrom`.
`DATABASE_URL/PGPASSWORD` are reserved for the database values.
Core runtime ConfigMap entries override same-named `app.extraConfig` entries;
use the dedicated app values to configure them.

Managed ConfigMap/Secret changes trigger pod rollout through checksums.
Externally managed Secret/ConfigMap updates require a Deployment restart or
your cluster's reloader. The default preStop hook waits five seconds for
endpoint removal then sends SIGINT, the current server's graceful shutdown
signal. Custom `lifecycleHooks` replaces that hook; disable or replace it if
you override the image or command. Keep the termination grace period longer
than the delay.

HPA utilization metrics require matching CPU/memory requests and the cluster's
metrics API; custom metrics need their corresponding adapter. The Deployment
omits `replicas` when HPA is enabled. PDB `minAvailable` and `maxUnavailable`
are mutually exclusive (set the unused field to `null`); a PDB with
`minAvailable: 1` can block voluntary disruption of a single-replica release.
`unhealthyPodEvictionPolicy` needs Kubernetes 1.26+ with the feature available.

NetworkPolicy is disabled by default. When enabled, empty rule lists deny
all ingress and egress. Allow your gateway, PostgreSQL endpoint and DNS
(adapt DNS rules for NodeLocal DNS if used). Dataset and tile requests are
made by the browser, not the application pod.

## Validation and packaging

```sh
helm lint charts/wfs-map --strict
helm template maps charts/wfs-map -f site-values.yaml
HELM=helm python scripts/test-helm.py
helm package charts/wfs-map
```

The test script requires PyYAML. Set `KUBECONFORM=/path/to/kubeconform` for
strict native Kubernetes schema validation as well as render contracts.
The Helm CI workflow lints default/example values, checks 16 contract tests
and invalid configuration variants, validates native resources against
Kubernetes 1.30 schemas, and packages the chart. CNPG custom resources are
render-tested separately; their CRDs/operator validate them in the cluster.
No live cluster installation is performed by these tests.
