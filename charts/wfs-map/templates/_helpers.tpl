{{- define "wfs-map.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "wfs-map.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if contains (include "wfs-map.name" .) .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "wfs-map.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "wfs-map.namespace" -}}
{{- default .Release.Namespace .Values.namespaceOverride -}}
{{- end -}}

{{- define "wfs-map.selectorLabels" -}}
app.kubernetes.io/name: {{ include "wfs-map.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "wfs-map.labels" -}}
{{- $base := dict "helm.sh/chart" (printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_") "app.kubernetes.io/version" .Chart.AppVersion "app.kubernetes.io/managed-by" .Release.Service -}}
{{- $selector := include "wfs-map.selectorLabels" . | fromYaml -}}
{{- toYaml (mergeOverwrite $base .Values.commonLabels $selector) -}}
{{- end -}}

{{- define "wfs-map.render" -}}
{{- if kindIs "string" .value -}}
{{- tpl .value .context -}}
{{- else -}}
{{- tpl (toYaml .value) .context -}}
{{- end -}}
{{- end -}}

{{- define "wfs-map.image" -}}
{{- $registry := default .Values.image.registry .Values.global.imageRegistry -}}
{{- $image := .Values.image.repository -}}
{{- if $registry -}}{{- $image = printf "%s/%s" $registry $image -}}{{- end -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" $image .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" $image .Values.image.tag -}}
{{- end -}}
{{- end -}}

{{- define "wfs-map.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "wfs-map.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "wfs-map.databaseSecretName" -}}
{{- if .Values.externalDatabase.existingSecret -}}
{{- tpl .Values.externalDatabase.existingSecret . -}}
{{- else -}}
{{- printf "%s-database" (include "wfs-map.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "wfs-map.databaseUrl" -}}
{{- $db := .Values.externalDatabase -}}
{{- if $db.url -}}
{{- $db.url -}}
{{- else -}}
{{- $params := list (printf "sslmode=%s" ($db.sslMode | urlquery)) -}}
{{- range $key, $value := $db.parameters -}}
{{- $params = append $params (printf "%s=%s" ($key | urlquery | replace "+" "%20") (toString $value | urlquery | replace "+" "%20")) -}}
{{- end -}}
{{- $host := $db.host -}}
{{- if and (contains ":" $host) (not (hasPrefix "[" $host)) -}}
{{- $host = printf "[%s]" $host -}}
{{- end -}}
{{- printf "postgresql://%s@%s:%v/%s?%s" ($db.username | urlquery | replace "+" "%20") $host $db.port ($db.database | urlquery | replace "+" "%20") (join "&" $params) -}}
{{- end -}}
{{- end -}}

{{- define "wfs-map.validate" -}}
{{- $db := .Values.externalDatabase -}}
{{- if $db.existingSecret -}}
  {{- if or $db.url $db.password -}}
    {{- fail "externalDatabase: existingSecret cannot be combined with url or password; clear existingSecret to use inline credentials" -}}
  {{- end -}}
  {{- if eq (empty $db.existingSecretUrlKey) (empty $db.existingSecretPasswordKey) -}}
    {{- fail "externalDatabase: select exactly one existingSecretUrlKey or existingSecretPasswordKey" -}}
  {{- end -}}
{{- end -}}
{{- if not (and $db.existingSecret $db.existingSecretUrlKey) -}}
  {{- if not $db.url -}}
    {{- if or (empty $db.host) (empty $db.username) (empty $db.database) -}}
      {{- fail "externalDatabase: supply a URL Secret, a complete url, or host/username/database" -}}
    {{- end -}}
    {{- if hasKey $db.parameters "sslmode" -}}
      {{- fail "externalDatabase.parameters: configure sslmode through externalDatabase.sslMode" -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- if and .Values.pdb.enabled (ne (toString .Values.pdb.minAvailable) "<nil>") (ne (toString .Values.pdb.maxUnavailable) "<nil>") -}}
  {{- fail "pdb: configure only one of minAvailable and maxUnavailable" -}}
{{- end -}}
{{- if and .Values.pdb.enabled (eq (toString .Values.pdb.minAvailable) "<nil>") (eq (toString .Values.pdb.maxUnavailable) "<nil>") -}}
  {{- fail "pdb: configure minAvailable or maxUnavailable" -}}
{{- end -}}
{{- if gt (int .Values.autoscaling.minReplicas) (int .Values.autoscaling.maxReplicas) -}}
  {{- fail "autoscaling: minReplicas cannot exceed maxReplicas" -}}
{{- end -}}
{{- if and .Values.autoscaling.enabled (empty .Values.autoscaling.metrics) (empty .Values.autoscaling.targetCPUUtilizationPercentage) (empty .Values.autoscaling.targetMemoryUtilizationPercentage) -}}
  {{- fail "autoscaling: configure at least one CPU, memory or custom metric" -}}
{{- end -}}
{{- range .Values.extraEnvVars -}}
  {{- if has .name (list "DATABASE_URL" "PGPASSWORD") -}}
    {{- fail "extraEnvVars: configure DATABASE_URL/PGPASSWORD through externalDatabase" -}}
  {{- end -}}
{{- end -}}
{{- end -}}
