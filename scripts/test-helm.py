#!/usr/bin/env python3
"""Render contract tests; requires Helm 3+ and PyYAML, optional kubeconform."""
import base64
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "charts" / "wfs-map"
HELM = os.environ.get("HELM", "helm")
KUBECONFORM = os.environ.get("KUBECONFORM", shutil.which("kubeconform") or "")
SCHEMA_CACHE = tempfile.TemporaryDirectory(prefix="wfs-map-kube-schemas-")


class UniqueLoader(yaml.SafeLoader):
    pass


def mapping(loader, node, deep=False):
    result = {}
    for key, value in node.value:
        name = loader.construct_object(key, deep=deep)
        if name in result:
            raise ValueError(f"Duplicate YAML key: {name}")
        result[name] = loader.construct_object(value, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)


def render(values=None, files=(), expect_error=False):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "values.yaml"
        path.write_text(yaml.safe_dump(values or {}))
        command = [HELM, "template", "maps", str(CHART), "--namespace", "analytics",
                   "--kube-version", "1.30.0", "-f", str(path)]
        for file in files:
            command += ["-f", str(file)]
        result = subprocess.run(command, capture_output=True, text=True)
        if expect_error:
            if result.returncode == 0:
                raise AssertionError("Invalid values unexpectedly rendered")
            return result.stderr
        if result.returncode:
            raise AssertionError(result.stderr)
        docs = [doc for doc in yaml.load_all(result.stdout, Loader=UniqueLoader) if doc]
        if KUBECONFORM:
            # CNPG/operator schemas are not part of upstream Kubernetes schemas.
            native = "\n---\n".join(yaml.safe_dump(doc) for doc in docs
                                     if doc["apiVersion"].split("/")[0] != "postgresql.cnpg.io")
            checked = subprocess.run(
                [KUBECONFORM, "-strict", "-summary", "-cache", SCHEMA_CACHE.name,
                 "-kubernetes-version", "1.30.0"],
                input=native, text=True, capture_output=True)
            if checked.returncode:
                raise AssertionError(checked.stdout + checked.stderr)
        return docs


def resource(docs, kind):
    matches = [doc for doc in docs if doc["kind"] == kind]
    if len(matches) != 1:
        raise AssertionError(f"Expected one {kind}, got {len(matches)}")
    return matches[0]


def pod(docs):
    return resource(docs, "Deployment")["spec"]["template"]["spec"]


class ChartTests(unittest.TestCase):
    def test_default_is_one_app_and_external_secret_only(self):
        docs = render()
        self.assertEqual({d["kind"] for d in docs},
                         {"Deployment", "Service", "ServiceAccount", "ConfigMap"})
        app = pod(docs)["containers"][0]
        self.assertEqual(app["image"], "ghcr.io/myaple/wfs-map:latest")
        self.assertEqual(app["ports"][0]["containerPort"], 8787)
        self.assertEqual(app["env"][0]["valueFrom"]["secretKeyRef"],
                         {"name": "wfs-map-database", "key": "uri"})
        self.assertFalse(pod(docs)["automountServiceAccountToken"])
        self.assertTrue(app["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(app["lifecycle"]["preStop"]["exec"]["command"][-1],
                         "sleep 5; kill -INT 1")
        self.assertNotIn("volumes", pod(docs))
        for doc in docs:
            self.assertEqual(doc["metadata"]["namespace"], "analytics")
        chart = yaml.safe_load((CHART / "Chart.yaml").read_text())
        self.assertFalse(chart.get("dependencies"))

    def test_config_and_rollout_checksums(self):
        a = render({"app": {"banner": {"text": "Internal <use>", "background": "#ffdf80"}}})
        b = render({"app": {"banner": {"text": "Changed"}}})
        data = resource(a, "ConfigMap")["data"]
        self.assertEqual(data["PAGE_BANNER_TEXT"], "Internal <use>")
        self.assertEqual(data["PAGE_BANNER_BACKGROUND"], "#ffdf80")
        self.assertEqual(data["AUTH_MODE"], "proxy")
        self.assertNotEqual(resource(a, "Deployment")["spec"]["template"]["metadata"]
                            ["annotations"]["checksum/config"],
                            resource(b, "Deployment")["spec"]["template"]["metadata"]
                            ["annotations"]["checksum/config"])

    def test_full_uri_stays_in_secret(self):
        uri = "postgresql://user:p%40ss@postgres.example/wfs?sslmode=verify-full"
        docs = render({"externalDatabase": {"existingSecret": "", "url": uri}})
        data = resource(docs, "Secret")["data"]
        self.assertEqual(base64.b64decode(data["DATABASE_URL"]).decode(), uri)
        self.assertNotIn("DATABASE_URL", resource(docs, "ConfigMap")["data"])
        self.assertEqual([e["name"] for e in pod(docs)["containers"][0]["env"]],
                         ["DATABASE_URL"])

    def test_password_secret_uses_libpq_env_without_uri_interpolation(self):
        docs = render({"externalDatabase": {
            "existingSecret": "{{ .Release.Name }}-credentials",
            "existingSecretUrlKey": "", "existingSecretPasswordKey": "password",
            "host": "db-rw", "username": "map user", "database": "map db",
            "sslMode": "verify-full", "parameters": {"sslrootcert": "/cert/my ca.crt"}}})
        uri = base64.b64decode(resource(docs, "Secret")["data"]["DATABASE_URL"]).decode()
        self.assertEqual(uri, "postgresql://map%20user@db-rw:5432/map%20db?"
                         "sslmode=verify-full&sslrootcert=%2Fcert%2Fmy%20ca.crt")
        self.assertEqual(pod(docs)["containers"][0]["env"][1]["valueFrom"]["secretKeyRef"],
                         {"name": "maps-credentials", "key": "password"})

    def test_inline_password_is_literal_secret_and_changes_checksum(self):
        db = {"existingSecret": "", "host": "db", "password": "p@ss:'$\\ word"}
        a = render({"externalDatabase": db})
        b = render({"externalDatabase": dict(db, password="rotated")})
        self.assertEqual(base64.b64decode(resource(a, "Secret")["data"]["PGPASSWORD"]).decode(),
                         db["password"])
        self.assertNotEqual(resource(a, "Deployment")["spec"]["template"]["metadata"]
                            ["annotations"]["checksum/database"],
                            resource(b, "Deployment")["spec"]["template"]["metadata"]
                            ["annotations"]["checksum/database"])

    def test_cnpg_example_and_templated_yaml_resources(self):
        docs = render(files=[CHART / "examples" / "cnpg.yaml"])
        cluster = resource(docs, "Cluster")
        self.assertEqual(cluster["metadata"]["name"], "maps-db")
        self.assertEqual(cluster["metadata"]["namespace"], "analytics")
        self.assertEqual(cluster["metadata"]["annotations"]["helm.sh/resource-policy"], "keep")
        self.assertEqual(cluster["spec"]["bootstrap"]["initdb"]["postInitApplicationSQL"],
                         ["CREATE EXTENSION IF NOT EXISTS postgis;"])
        self.assertEqual(pod(docs)["containers"][0]["env"][0]["valueFrom"]["secretKeyRef"],
                         {"name": "maps-db-app", "key": "uri"})
        docs = render({"extraResources": [
            'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: "{{ .Release.Name }}-extra"\n']})
        self.assertIn("maps-extra", [doc["metadata"]["name"] for doc in docs])

    def test_ingress_covers_entire_app_with_tls(self):
        docs = render(files=[CHART / "examples" / "external-postgres.yaml"])
        ingress = resource(docs, "Ingress")
        self.assertEqual(ingress["spec"]["ingressClassName"], "nginx")
        self.assertEqual(ingress["spec"]["tls"][0]["secretName"], "maps-tls")
        paths = ingress["spec"]["rules"][0]["http"]["paths"]
        self.assertEqual(paths, [{"path": "/", "pathType": "Prefix",
                                "backend": {"service": {"name": "maps-wfs-map",
                                                        "port": {"number": 80}}}}])
        self.assertEqual(resource(docs, "NetworkPolicy")["spec"]["egress"][0]["ports"][0]["port"],
                         5432)

    def test_custom_pod_security_volumes_scheduling_and_sidecars(self):
        values = {
            "podSecurityContext": {"runAsUser": None, "fsGroup": 2000},
            "containerSecurityContext": {"readOnlyRootFilesystem": False},
            "extraVolumes": [{"name": "certs", "secret": {"secretName": "{{ .Release.Name }}-ca"}},
                             {"name": "scratch", "emptyDir": {}}],
            "extraVolumeMounts": [{"name": "certs", "mountPath": "/cert", "readOnly": True},
                                 {"name": "scratch", "mountPath": "/tmp"}],
            "extraEnvVars": [{"name": "RELEASE_NAME", "value": "{{ .Release.Name }}"}],
            "extraEnvVarsCM": "{{ .Release.Name }}-env",
            "extraEnvVarsSecret": "extra-secrets",
            "extraEnvFrom": [{"configMapRef": {"name": "more-env"}}],
            "initContainers": [{"name": "prepare", "image": "busybox:1.37",
                                "command": ["sh", "-c", "true"]}],
            "sidecars": [{"name": "gateway", "image": "nginx:1.28",
                          "ports": [{"name": "gateway", "containerPort": 8080}]}],
            "service": {"targetPort": "gateway"},
            "nodeSelector": {"kubernetes.io/os": "linux"},
            "tolerations": [{"key": "dedicated", "operator": "Exists"}],
            "affinity": {"podAntiAffinity": {"preferredDuringSchedulingIgnoredDuringExecution": [
                {"weight": 100, "podAffinityTerm": {"topologyKey": "kubernetes.io/hostname",
                 "labelSelector": {"matchLabels": {"app.kubernetes.io/instance":
                                                   "{{ .Release.Name }}"}}}}]}},
            "topologySpreadConstraints": [{"maxSkew": 1, "topologyKey": "topology.kubernetes.io/zone",
                "whenUnsatisfiable": "ScheduleAnyway", "labelSelector": {"matchLabels": {
                    "app.kubernetes.io/instance": "{{ .Release.Name }}"}}}],
            "hostNetwork": True, "priorityClassName": "important", "runtimeClassName": "sandbox",
            "resources": {"requests": {"cpu": "100m", "memory": "128Mi"}},
        }
        docs = render(values)
        spec = pod(docs)
        self.assertNotIn("runAsUser", spec["securityContext"])
        self.assertEqual(spec["securityContext"]["fsGroup"], 2000)
        self.assertEqual(spec["volumes"][0]["secret"]["secretName"], "maps-ca")
        self.assertEqual(spec["containers"][1]["name"], "gateway")
        self.assertEqual(spec["containers"][0]["env"][-1]["value"], "maps")
        self.assertEqual(spec["containers"][0]["envFrom"][1]["configMapRef"]["name"], "maps-env")
        self.assertEqual(spec["dnsPolicy"], "ClusterFirstWithHostNet")
        self.assertEqual(resource(docs, "Service")["spec"]["ports"][0]["targetPort"], "gateway")

    def test_contexts_and_probes_can_be_removed_and_replaced(self):
        docs = render({"podSecurityContext": {"enabled": False},
                       "containerSecurityContext": {"enabled": False},
                       "startupProbe": {"enabled": False},
                       "livenessProbe": {"httpGet": None, "tcpSocket": {"port": "http"}},
                       "readinessProbe": {"httpGet": None, "exec": {"command": ["/bin/true"]}},
                       "gracefulShutdown": {"enabled": False},
                       "command": ["/custom/server"], "args": ["--port=8787"]})
        app = pod(docs)["containers"][0]
        self.assertNotIn("securityContext", pod(docs))
        self.assertNotIn("securityContext", app)
        self.assertNotIn("startupProbe", app)
        self.assertNotIn("httpGet", app["livenessProbe"])
        self.assertEqual(app["readinessProbe"]["exec"]["command"], ["/bin/true"])
        self.assertNotIn("lifecycle", app)

    def test_custom_lifecycle_and_zero_pdb(self):
        docs = render({"lifecycleHooks": {"preStop": {"exec": {"command": ["/bin/true"]}}},
                       "pdb": {"enabled": True, "minAvailable": None, "maxUnavailable": 0}})
        self.assertEqual(resource(docs, "PodDisruptionBudget")["spec"]["maxUnavailable"], 0)
        self.assertEqual(pod(docs)["containers"][0]["lifecycle"]["preStop"]["exec"]["command"],
                         ["/bin/true"])

    def test_autoscaling_omits_deployment_replicas(self):
        docs = render({"autoscaling": {"enabled": True, "minReplicas": 2, "maxReplicas": 8,
                        "targetMemoryUtilizationPercentage": 70,
                        "behavior": {"scaleDown": {"stabilizationWindowSeconds": 180}}},
                       "pdb": {"enabled": True, "minAvailable": "50%"}})
        self.assertNotIn("replicas", resource(docs, "Deployment")["spec"])
        self.assertEqual(resource(docs, "HorizontalPodAutoscaler")["spec"]["maxReplicas"], 8)
        self.assertEqual(len(resource(docs, "HorizontalPodAutoscaler")["spec"]["metrics"]), 2)
        custom = [{"type": "Pods", "pods": {"metric": {"name": "requests"},
                   "target": {"type": "AverageValue", "averageValue": "10"}}}]
        docs = render({"autoscaling": {"enabled": True, "metrics": custom}})
        self.assertEqual(resource(docs, "HorizontalPodAutoscaler")["spec"]["metrics"], custom)

    def test_image_service_account_and_names(self):
        digest = "sha256:" + "a" * 64
        docs = render({"fullnameOverride": "workspace", "namespaceOverride": "other",
            "image": {"digest": digest, "pullSecrets": ["local"]},
            "global": {"imageRegistry": "registry.internal", "imagePullSecrets": [{"name": "global"}]},
            "serviceAccount": {"create": False, "name": "existing"}})
        self.assertFalse(any(doc["kind"] == "ServiceAccount" for doc in docs))
        self.assertEqual(pod(docs)["serviceAccountName"], "existing")
        self.assertEqual(pod(docs)["containers"][0]["image"],
                         "registry.internal/myaple/wfs-map@" + digest)
        self.assertEqual(pod(docs)["imagePullSecrets"], [{"name": "global"}, {"name": "local"}])
        for doc in docs:
            self.assertEqual(doc["metadata"]["namespace"], "other")

    def test_metadata_cannot_break_selectors(self):
        docs = render({"commonLabels": {"app.kubernetes.io/instance": "wrong", "team": "gis"},
                       "podLabels": {"app.kubernetes.io/name": "wrong"},
                       "commonAnnotations": {"owner": "gis"},
                       "podAnnotations": {"checksum/config": "wrong"}})
        dep = resource(docs, "Deployment")
        labels = dep["spec"]["template"]["metadata"]["labels"]
        for key, value in dep["spec"]["selector"]["matchLabels"].items():
            self.assertEqual(labels[key], value)
        self.assertEqual(labels["team"], "gis")
        self.assertNotEqual(dep["spec"]["template"]["metadata"]["annotations"]["checksum/config"],
                            "wrong")

    def test_nodeport_and_service_settings(self):
        docs = render({"service": {"type": "NodePort", "port": 8080, "nodePort": 30878,
             "externalTrafficPolicy": "Local", "internalTrafficPolicy": "Cluster",
             "sessionAffinity": "ClientIP", "ipFamilyPolicy": "SingleStack", "ipFamilies": ["IPv4"],
             "extraPorts": [{"name": "metrics", "port": 9090, "targetPort": 9090}]}})
        service = resource(docs, "Service")["spec"]
        self.assertEqual(service["ports"][0]["nodePort"], 30878)
        self.assertEqual(service["externalTrafficPolicy"], "Local")
        self.assertEqual(len(service["ports"]), 2)

    def test_network_policy_default_deny_when_enabled(self):
        spec = resource(render({"networkPolicy": {"enabled": True}}), "NetworkPolicy")["spec"]
        self.assertEqual(spec["ingress"], [])
        self.assertEqual(spec["egress"], [])

    def test_invalid_values_fail_early(self):
        invalid = [
            {"externalDatabase": {"existingSecret": "", "url": "", "host": ""}},
            {"externalDatabase": {"url": "postgresql://db/wfs"}},
            {"externalDatabase": {"existingSecretPasswordKey": "password"}},
            {"externalDatabase": {"existingSecretUrlKey": "", "existingSecretPasswordKey": ""}},
            {"externalDatabase": {"existingSecret": "", "host": "db", "parameters": {"sslmode": "require"}}},
            {"pdb": {"enabled": True, "maxUnavailable": 0}},
            {"pdb": {"enabled": True, "minAvailable": None, "maxUnavailable": None}},
            {"autoscaling": {"enabled": True, "minReplicas": 5, "maxReplicas": 2}},
            {"autoscaling": {"enabled": True, "targetCPUUtilizationPercentage": None}},
            {"extraEnvVars": [{"name": "DATABASE_URL", "value": "bad"}]},
            {"app": {"auth": {"mode": "typo"}}},
            {"app": {"containerPort": 0}},
            {"image": {"digest": "sha256:invalid"}},
            {"ingress": {"hosts": [{"host": "example", "paths": [{"path": "/", "pathType": "Typo"}]}]}},
            {"externalDatabase": {"hots": "typo"}},
        ]
        for values in invalid:
            with self.subTest(values=values):
                render(values, expect_error=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
