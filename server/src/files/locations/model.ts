/*
 * Linked storage locations in Files (2.0.0). A workspace links outside storage: S3-compatible buckets (AWS, MinIO,
 * Ceph, any self-hosted endpoint), Azure Blob containers, local directories an operator offers (Storage › Local
 * stores), SFTP and FTP(S) servers, and IPFS (a Kubo node's RPC API, or a read-only gateway). People with `files:read`
 * browse a location; `files:write` copies a file in (it becomes an ordinary Files upload: quarantined, scanned,
 * labelled and counted against the quota) or sends a Files file out. Nothing is mounted: remote files are never
 * served from Files without being copied in first.
 *
 * Every network connector reaches its host only through `files/locations/net.ts`: the host is resolved once, each
 * address is checked (`AddressCheck`: cloud metadata always refused; internal addresses only when the operator's
 * SERVICE_ALLOWED_HOSTS names them; public addresses only when the tenant's list of allowed hosts does), and the
 * connection is pinned to the checked address. Credentials are sealed with the tenant key (associated data
 * `file-location:<id>`) and never returned by the API.
 */

export const LOCATION_KINDS = ['s3', 'azure', 'local', 'sftp', 'ftp', 'ipfs'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/** Why an address may not be dialled, or null when it may (see the comment above). */
export type AddressCheck = (address: string, host: string) => string | null;

/** One entry of a listing. `path` is relative to the location's root, `/`-separated, without a leading slash. */
export interface RemoteEntry {
  path: string;
  name: string;
  dir: boolean;
  size: number | null;
  /** Milliseconds since the epoch. */
  modified: number | null;
  /** An ETag, a content hash or a CID when the remote gives one. */
  etag?: string | null;
  /** A MIME type when the remote states one (never trusted: the scan reads the bytes). */
  type?: string | null;
}

export interface Listing {
  entries: RemoteEntry[];
  /** An opaque cursor for the next page, or null at the end. */
  next: string | null;
}

export interface ReadResult {
  stream: AsyncIterable<Buffer>;
  size: number | null;
  type: string | null;
}

/** What a connector needs besides its own config and secret. */
export interface ConnectorContext {
  check: AddressCheck;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Local stores only: the operator's root, resolved (`file_local_roots.path`) and whether it is read-only. */
  localRoot?: { path: string; readOnly: boolean };
}

/**
 * A connector to one location. Paths are relative to the location's root (config `prefix`, `root` or `path`); a
 * connector refuses `..`, NUL and absolute paths (`cleanPath`). `list` gives one directory level; `read` streams a
 * file (the caller caps the bytes); `write` stores a file of `size` bytes, replacing one of the same path.
 */
export interface Connector {
  readonly kind: LocationKind;
  test(): Promise<{ ok: true; detail: string }>;
  list(dir: string, cursor?: string | null): Promise<Listing>;
  stat(path: string): Promise<RemoteEntry | null>;
  read(path: string): Promise<ReadResult>;
  write(path: string, data: AsyncIterable<Buffer>, size: number, type: string | null): Promise<{ etag?: string | null; cid?: string | null }>;
  /** Writable at all (an IPFS gateway, a read-only local store and a location marked read-only are not). */
  readonly writable: boolean;
  close(): Promise<void>;
}

// ---------- per-kind configuration (stored in the clear) and secrets (sealed) ----------

export interface S3Config {
  /** https://s3.eu-west-1.amazonaws.com, http://minio.local:9000, … */
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  /** Which service the endpoint is, for the console only. */
  flavour: 'aws' | 'minio' | 'self-hosted';
}
export interface S3Secret {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AzureConfig {
  /** https://<account>.blob.core.windows.net, or Azurite's http://127.0.0.1:10000/<account> */
  endpoint: string;
  account: string;
  container: string;
  prefix: string;
}
/** A shared key (account key, base64) or a SAS token (query string without the leading ?). */
export type AzureSecret = { accountKey: string } | { sas: string };

export interface LocalConfig {
  /** `file_local_roots.id` an operator offers to this tenant. */
  rootId: string;
  /** A subdirectory of the root (relative). */
  path: string;
}

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  root: string;
  /** SHA256:… host key fingerprint, pinned at link time (trust on first use when absent, then stored). */
  hostKey: string | null;
}
export type SftpSecret = { password: string } | { privateKey: string; passphrase?: string };

export interface FtpConfig {
  host: string;
  port: number;
  username: string;
  root: string;
  /** 'explicit' (AUTH TLS), 'implicit' (port 990) or 'none' (refused unless the host is internal). */
  tls: 'explicit' | 'implicit' | 'none';
}
export type FtpSecret = { password: string };

export interface IpfsConfig {
  /** 'rpc': a Kubo node's RPC API (http://127.0.0.1:5001), read and write. 'gateway': https://ipfs.io, read only. */
  mode: 'rpc' | 'gateway';
  endpoint: string;
  /** Where browsing starts: a CID or an /ipns/ name; empty to browse nothing but fetch by CID. */
  root: string;
  /** rpc only: pin what is added. */
  pin: boolean;
}
export type IpfsSecret = { authorization?: string } | null;

export type LocationConfig = S3Config | AzureConfig | LocalConfig | SftpConfig | FtpConfig | IpfsConfig;

/** Limits of browsing and copying. */
export const LOCATION_LIMITS = {
  /** Entries per listing page. */
  pageSize: 500,
  /** Files in one import or export job. */
  maxBatch: 1_000,
  timeoutMs: 60_000
};

/** A relative path without `..`, NUL, backslashes or a leading slash; empty for the root. Throws a plain Error. */
export function cleanPath(raw: string): string {
  const p = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(p) || p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) throw new Error(`Not a valid path: ${raw}`);
  if (p.length > 1024) throw new Error('The path is too long.');
  return p;
}

/** A remote failure the API answers with 502 (the remote refused or could not be reached), message shown as is. */
export class RemoteError extends Error {
  constructor(
    message: string,
    readonly status = 502
  ) {
    super(message);
  }
}

/*
 * ---------- the HTTP contract (routes/files-locations.ts) ----------
 *
 * Locations (workspace members see their workspace's locations; `files:link` adds, edits and removes them):
 *   GET    /api/files/locations?workspace=          → [locationView]
 *   POST   /api/files/locations                      { workspaceId?, name, kind, config, secret?, label, readOnly? } → 201 locationView
 *   PATCH  /api/files/locations/:id                  { name?, config?, secret?, label?, readOnly? } → locationView
 *   DELETE /api/files/locations/:id                  → 204
 *   POST   /api/files/locations/:id/test             → { ok, detail, hostKey? }
 *   POST   /api/files/locations/test                 { kind, config, secret } (before saving) → { ok, detail, hostKey? }
 *   locationView = { id, workspaceId, name, kind, config (no secrets), hasSecret, label, readOnly, writable, state,
 *                    lastCheckedAt, lastError, createdBy, createdAt, updatedAt }
 * Browsing and copying:
 *   GET    /api/files/locations/:id/browse?path=&cursor=   → { location, path, entries: RemoteEntry[], next }
 *   POST   /api/files/locations/:id/import   { paths: string[], folderId?, label? } → 202 { jobId } (one file and small:
 *                                              done at once → 202 { files: [fileView] })
 *   POST   /api/files/:id/send               { locationId, path? (default: the file's name at the root) } → 200 { path, etag?, cid? }
 * Local stores (operators, `platform:manage`):
 *   GET    /api/admin/storage/local-roots     POST same { name, path, readOnly, tenants: string[] | null }
 *   PATCH  /api/admin/storage/local-roots/:id DELETE same
 *   GET    /api/files/local-roots             → the roots offered to the caller's tenant (for the Add location dialog)
 * Imports from elsewhere (files/imports.ts, routes/files-imports.ts), each → 202 { ...fileView, version }:
 *   POST   /api/files/import/url              { url, name?, folderId?, label? }
 *   POST   /api/files/import/database         { connectionId, object? | sql? | savedQueryId?, params?, format: csv|xlsx|json, name?, folderId? }
 *   POST   /api/files/import/knowledge        { documentId, as: 'original' | 'text' | 'markdown', folderId? }
 *   POST   /api/files/import/agent-run        { runId, format: 'markdown' | 'json', folderId? }
 *   POST   /api/files/import/workflow-run     { runId, format: 'markdown' | 'json', folderId? }
 *   POST   /api/files/import/workflow         { workflowId, folderId? }   (the signed exprsn-workflow/1 bundle)
 *   POST   /api/files/import/skill            { skillId, folderId? }      (the skill as Markdown with its front matter)
 *   POST   /api/files/import/tool             { toolId, folderId? }       (the tool's definition as JSON)
 *   GET    /api/files/import/sources?kind=    → pickable items of a kind the caller may read
 */
