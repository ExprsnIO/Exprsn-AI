import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { ClusterAccess } from './providers/types.js';

/*
 * 1.9.99-final, Sprint 58 (B-10203): the kubeconfig the deploy worker hands `helm`, one per operation. It holds the
 * cluster's short-lived token (an EKS presigned-STS token, an AKS Entra token, DOKS credentials), so it lives in a
 * private temporary directory (0700, the file 0600, created exclusively) and is deleted when the operation ends,
 * whether it worked or not. It is never logged, never stored, and never passed through the environment.
 */

export function kubeconfigYaml(a: ClusterAccess): string {
  const name = a.clusterName.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 63) || 'cluster';
  return stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name, cluster: { server: a.server, ...(a.caData ? { 'certificate-authority-data': a.caData } : {}) } }],
    users: [{ name: 'exprsn-ai-deploy', user: { token: a.token } }],
    contexts: [{ name, context: { cluster: name, user: 'exprsn-ai-deploy' } }],
    'current-context': name,
    preferences: {}
  });
}

/** Runs `fn` with a private kubeconfig file for `access`, deleted afterwards. */
export async function withKubeconfig<T>(access: ClusterAccess, fn: (path: string) => Promise<T>, o: { dir?: string; onWrite?: (path: string) => void } = {}): Promise<T> {
  if (access.expiresAt <= Date.now()) throw new Error('The cluster token has already expired; ask for a new one.');
  const dir = await mkdtemp(join(o.dir ?? tmpdir(), 'exprsn-kube-'));
  const file = join(dir, 'kubeconfig');
  try {
    await writeFile(file, kubeconfigYaml(access), { mode: 0o600, flag: 'wx' });
    o.onWrite?.(file);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
