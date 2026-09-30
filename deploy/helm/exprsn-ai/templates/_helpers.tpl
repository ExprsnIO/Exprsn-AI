{{/* Chart name, truncated to the DNS label limit. */}}
{{- define "exprsn-ai.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name. */}}
{{- define "exprsn-ai.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "exprsn-ai.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "exprsn-ai.selectorLabels" -}}
app.kubernetes.io/name: {{ include "exprsn-ai.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* The server pods only (not the migration Job's pods): for the Deployment, the Service and the PDB. */}}
{{- define "exprsn-ai.serverSelectorLabels" -}}
{{ include "exprsn-ai.selectorLabels" . }}
app.kubernetes.io/component: server
{{- end }}

{{- define "exprsn-ai.labels" -}}
helm.sh/chart: {{ include "exprsn-ai.chart" . }}
{{ include "exprsn-ai.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: exprsn-ai
{{- end }}

{{- define "exprsn-ai.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "exprsn-ai.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "exprsn-ai.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}
{{- end }}

{{/* Highest replica count the release can reach: decides whether Redis and a shared volume are required. */}}
{{- define "exprsn-ai.maxReplicas" -}}
{{- if .Values.autoscaling.enabled }}{{ .Values.autoscaling.maxReplicas }}{{ else }}{{ .Values.replicaCount }}{{ end }}
{{- end }}

{{- define "exprsn-ai.minReplicas" -}}
{{- if .Values.autoscaling.enabled }}{{ .Values.autoscaling.minReplicas }}{{ else }}{{ .Values.replicaCount }}{{ end }}
{{- end }}

{{/* True when the secret variable has a Secret name. */}}
{{- define "exprsn-ai.hasSecret" -}}
{{- $ref := index .root.Values.secrets .name | default dict }}
{{- if $ref.name }}true{{ end }}
{{- end }}

{{/* Refuses combinations the server would reject at start, so the failure shows at install time. */}}
{{- define "exprsn-ai.validate" -}}
{{- $v := .Values }}
{{- if not $v.config.publicUrl }}
{{- fail "config.publicUrl is required (the https:// address users open)" }}
{{- end }}
{{- if and (eq $v.config.nodeEnv "production") (not (hasPrefix "https://" $v.config.publicUrl)) }}
{{- fail "config.publicUrl must start with https:// when config.nodeEnv=production" }}
{{- end }}
{{- if not (has $v.config.database.client (list "pg" "mysql")) }}
{{- fail "config.database.client must be pg or mysql (SQLite is for single-node Compose and systemd installs)" }}
{{- end }}
{{- if not (include "exprsn-ai.hasSecret" (dict "root" . "name" "SESSION_SECRET")) }}
{{- fail "secrets.SESSION_SECRET.name is required" }}
{{- end }}
{{- if not (include "exprsn-ai.hasSecret" (dict "root" . "name" "DATABASE_URL")) }}
{{- fail "secrets.DATABASE_URL.name is required" }}
{{- end }}
{{- if and (eq $v.config.kms.provider "local") (not (include "exprsn-ai.hasSecret" (dict "root" . "name" "DATA_KEY"))) }}
{{- fail "secrets.DATA_KEY.name is required when config.kms.provider=local" }}
{{- end }}
{{- if eq $v.config.kms.provider "openbao" }}
{{- if or (not $v.config.kms.openbao.addr) (not (include "exprsn-ai.hasSecret" (dict "root" . "name" "OPENBAO_TOKEN"))) }}
{{- fail "config.kms.openbao.addr and secrets.OPENBAO_TOKEN.name are required when config.kms.provider=openbao" }}
{{- end }}
{{- end }}
{{- if not (has $v.config.kms.provider (list "local" "openbao")) }}
{{- fail "config.kms.provider must be local or openbao" }}
{{- end }}
{{- if eq $v.config.blobStore.type "s3" }}
{{- $s3 := $v.config.blobStore.s3 }}
{{- if or (not $s3.endpoint) (not $s3.bucket) (not $s3.accessKeyId) (not (include "exprsn-ai.hasSecret" (dict "root" . "name" "S3_SECRET_ACCESS_KEY"))) }}
{{- fail "config.blobStore.s3.endpoint, .bucket, .accessKeyId and secrets.S3_SECRET_ACCESS_KEY.name are required when config.blobStore.type=s3" }}
{{- end }}
{{- else if eq $v.config.blobStore.type "pvc" }}
{{- if and (gt (int (include "exprsn-ai.maxReplicas" .)) 1) (not $v.config.blobStore.pvc.existingClaim) (not (has "ReadWriteMany" $v.config.blobStore.pvc.accessModes)) }}
{{- fail "config.blobStore.pvc.accessModes must include ReadWriteMany when more than one replica shares the blob volume" }}
{{- end }}
{{- else }}
{{- fail "config.blobStore.type must be s3 or pvc" }}
{{- end }}
{{- if and (gt (int (include "exprsn-ai.maxReplicas" .)) 1) (not (include "exprsn-ai.hasSecret" (dict "root" . "name" "REDIS_URL"))) }}
{{- fail "secrets.REDIS_URL.name is required when more than one replica can run (Socket.io adapter, job queue, bus)" }}
{{- end }}
{{- if and $v.serviceMonitor.enabled (not (include "exprsn-ai.hasSecret" (dict "root" . "name" "METRICS_TOKEN"))) }}
{{- fail "secrets.METRICS_TOKEN.name is required when serviceMonitor.enabled (/metrics is off in production without it)" }}
{{- end }}
{{- if not (has $v.migrations.mode (list "initContainer" "job" "none")) }}
{{- fail "migrations.mode must be initContainer, job or none" }}
{{- end }}
{{- end }}

{{/* Non-secret environment, shared by the ConfigMap and the migration hook's ConfigMap. */}}
{{- define "exprsn-ai.configData" -}}
{{- $c := .Values.config }}
NODE_ENV: {{ $c.nodeEnv | quote }}
PUBLIC_URL: {{ $c.publicUrl | quote }}
TRUST_PROXY: {{ $c.trustProxy | quote }}
LOG_LEVEL: {{ $c.logLevel | quote }}
DEFAULT_TENANT: {{ $c.defaultTenant | quote }}
DB_CLIENT: {{ $c.database.client | quote }}
DB_POOL_MAX: {{ $c.database.poolMax | toString | quote }}
DB_MIGRATE_ON_START: {{ ternary "true" "false" (eq .Values.migrations.mode "none") | quote }}
KMS_PROVIDER: {{ $c.kms.provider | quote }}
{{- if eq $c.kms.provider "openbao" }}
OPENBAO_ADDR: {{ $c.kms.openbao.addr | quote }}
OPENBAO_TRANSIT_MOUNT: {{ $c.kms.openbao.transitMount | quote }}
OPENBAO_KEY_PREFIX: {{ $c.kms.openbao.keyPrefix | quote }}
{{- if $c.kms.openbao.caSecret.name }}
OPENBAO_CA_FILE: "/run/secrets/openbao_ca.pem"
{{- end }}
{{- end }}
{{- if eq $c.blobStore.type "s3" }}
BLOB_STORE: "s3"
S3_ENDPOINT: {{ $c.blobStore.s3.endpoint | quote }}
S3_REGION: {{ $c.blobStore.s3.region | quote }}
S3_BUCKET: {{ $c.blobStore.s3.bucket | quote }}
S3_ACCESS_KEY_ID: {{ $c.blobStore.s3.accessKeyId | quote }}
S3_FORCE_PATH_STYLE: {{ $c.blobStore.s3.forcePathStyle | toString | quote }}
{{- else }}
BLOB_STORE: "fs"
BLOB_DIR: "/var/lib/exprsn-ai/blobs"
{{- end }}
JOB_QUEUE: {{ ternary "bullmq" "db" (not (empty (include "exprsn-ai.hasSecret" (dict "root" . "name" "REDIS_URL")))) | quote }}
WORKERS_ENABLED: {{ $c.workersEnabled | toString | quote }}
JOB_CONCURRENCY: {{ $c.jobConcurrency | toString | quote }}
SMTP_FROM: {{ $c.smtpFrom | quote }}
{{- if $c.siemUrl }}
SIEM_URL: {{ $c.siemUrl | quote }}
{{- end }}
SCRIPT_RUNNER: {{ $c.scriptRunner | quote }}
IDENTITY_CONFIG: {{ ternary "/etc/exprsn-ai/identity.yaml" "" (or (not (empty .Values.identity.config)) (not (empty .Values.identity.existingConfigMap))) | quote }}
{{- range $k, $val := $c.extra }}
{{ $k }}: {{ $val | toString | quote }}
{{- end }}
{{- end }}

{{/* <NAME>_FILE variables for the secrets that are set. */}}
{{- define "exprsn-ai.secretEnv" -}}
{{- range $name, $ref := .Values.secrets }}
{{- if and $ref $ref.name }}
- name: {{ $name }}_FILE
  value: /run/secrets/{{ lower $name }}
{{- end }}
{{- end }}
{{- end }}

{{/* One projected volume with every secret file, mounted read-only at /run/secrets. */}}
{{- define "exprsn-ai.secretVolume" -}}
- name: secrets
  projected:
    defaultMode: 0440
    sources:
      {{- range $name, $ref := .Values.secrets }}
      {{- if and $ref $ref.name }}
      - secret:
          name: {{ $ref.name }}
          items:
            - key: {{ $ref.key }}
              path: {{ lower $name }}
      {{- end }}
      {{- end }}
      {{- with .Values.config.kms.openbao.caSecret }}
      {{- if and .name (eq $.Values.config.kms.provider "openbao") }}
      - secret:
          name: {{ .name }}
          items:
            - key: {{ .key }}
              path: openbao_ca.pem
      {{- end }}
      {{- end }}
      {{- range .Values.extraSecretFiles }}
      - secret:
          name: {{ .name }}
          items:
            - key: {{ .key }}
              path: {{ .path }}
      {{- end }}
{{- end }}

{{/* Volumes every server container needs: secrets, /tmp, the data directory and the identity YAML. */}}
{{- define "exprsn-ai.volumes" -}}
{{ include "exprsn-ai.secretVolume" . }}
- name: tmp
  emptyDir:
    {{- if .Values.tmpDir.medium }}
    medium: {{ .Values.tmpDir.medium }}
    {{- end }}
    sizeLimit: {{ .Values.tmpDir.sizeLimit }}
- name: data
  {{- if eq .Values.config.blobStore.type "pvc" }}
  persistentVolumeClaim:
    claimName: {{ default (printf "%s-blobs" (include "exprsn-ai.fullname" .)) .Values.config.blobStore.pvc.existingClaim }}
  {{- else }}
  emptyDir:
    sizeLimit: 1Gi
  {{- end }}
{{- if or .Values.identity.config .Values.identity.existingConfigMap }}
- name: identity
  configMap:
    name: {{ default (printf "%s-identity" (include "exprsn-ai.fullname" .)) .Values.identity.existingConfigMap }}
    items:
      - key: identity.yaml
        path: identity.yaml
{{- end }}
{{- with .Values.extraVolumes }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{- define "exprsn-ai.volumeMounts" -}}
- name: secrets
  mountPath: /run/secrets
  readOnly: true
- name: tmp
  mountPath: /tmp
- name: data
  mountPath: /var/lib/exprsn-ai
{{- if or .Values.identity.config .Values.identity.existingConfigMap }}
- name: identity
  mountPath: /etc/exprsn-ai
  readOnly: true
{{- end }}
{{- with .Values.extraVolumeMounts }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* Environment for every server container: the ConfigMap, the secret files and anything extra. */}}
{{- define "exprsn-ai.envFrom" -}}
- configMapRef:
    name: {{ .configMap }}
{{- with .root.Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{- define "exprsn-ai.env" -}}
{{ include "exprsn-ai.secretEnv" . }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end }}
