import { CloudCallError, form, type CloudHttp } from './credential-http.js';

/*
 * 1.9.99-final, Sprint 56 (B-10004, B-10006): the Entra and Microsoft Graph calls credentials need.
 *
 * - The token endpoint (`<authority>/<tenant>/oauth2/v2.0/token`, client credentials grant) with a client assertion
 *   (a token from Exprsn-AI's issuer for a federated identity credential, or a JWT signed with a certificate's key
 *   in the signer) or a client secret.
 * - Graph `addPassword` and `removePassword` on the app registration (automatic rotation of a vaulted client secret,
 *   when the app may change its own credentials: Application.ReadWrite.OwnedBy).
 *
 * The authority and Graph URLs are settings (CLOUD_AZURE_AUTHORITY, CLOUD_AZURE_GRAPH_URL) for the tests' fake.
 */

export const AZURE_EXCHANGE_AUDIENCE = 'api://AzureADTokenExchange';

/** The scopes the credentials hand out tokens for. Cost Management is served under the ARM scope. */
export const AZURE_SCOPES = {
  arm: 'https://management.azure.com/.default',
  cognitive: 'https://cognitiveservices.azure.com/.default',
  storage: 'https://storage.azure.com/.default',
  graph: 'https://graph.microsoft.com/.default',
  /** 1.9.99-final, Sprint 58 (B-10203): the AKS server application (AKS-managed Entra ID clusters' API). */
  aks: '6dae42f8-4368-4678-94ff-3960e28e3630/.default',
  /** 1.9.99-final, Sprint 59 (B-10304, B-10306): the Cosmos DB data plane and Entra sign-in to Azure Database for PostgreSQL. */
  cosmos: 'https://cosmos.azure.com/.default',
  ossrdbms: 'https://ossrdbms-aad.database.windows.net/.default'
} as const;

export interface EntraToken {
  token: string;
  expiresAt: number;
}

const trimBase = (u: string) => u.replace(/\/+$/, '');

export const tokenEndpoint = (authority: string, tenantId: string): string => `${trimBase(authority)}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

/** One access token for a scope, by client assertion or client secret. */
export async function entraToken(http: CloudHttp, authority: string, o: { tenantId: string; clientId: string; scope: string } & ({ assertion: string } | { secret: string })): Promise<EntraToken> {
  const params: Record<string, string> = { client_id: o.clientId, scope: o.scope, grant_type: 'client_credentials' };
  if ('assertion' in o) Object.assign(params, { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: o.assertion });
  else params.client_secret = o.secret;
  const res = await http.request({ method: 'POST', url: tokenEndpoint(authority, o.tenantId), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form(params) });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (res.status !== 200 || typeof body.access_token !== 'string') {
    const code = typeof body.error === 'string' ? body.error : null;
    // error_description names the cause (AADSTS codes) and never echoes the secret or the assertion.
    const desc = typeof body.error_description === 'string' ? body.error_description.split('\n')[0]!.slice(0, 300) : '';
    throw new CloudCallError(`Entra refused the token request${code ? ` (${code})` : ''}${desc ? `: ${desc}` : ''}.`, res.status === 400 || res.status === 401 ? 403 : 502, code);
  }
  const expiresIn = Number(body.expires_in ?? 3600);
  return { token: body.access_token, expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000 };
}

async function graph(http: CloudHttp, graphUrl: string, token: string, path: string, payload: unknown): Promise<Record<string, unknown>> {
  const res = await http.request({ method: 'POST', url: `${trimBase(graphUrl)}/v1.0${path}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload) });
  const text = res.body.toString('utf8');
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* not JSON */
  }
  if (res.status >= 300) {
    const err = (body.error ?? {}) as Record<string, unknown>;
    throw new CloudCallError(`Microsoft Graph refused the call${typeof err.code === 'string' ? ` (${err.code})` : ''}${typeof err.message === 'string' ? `: ${err.message.slice(0, 300)}` : ''}.`, res.status === 403 || res.status === 401 ? 403 : res.status === 404 ? 404 : 502, typeof err.code === 'string' ? err.code : null);
  }
  return body;
}

const appPath = (clientId: string) => `/applications(appId='${encodeURIComponent(clientId)}')`;

/** A new client secret on the app registration. `secretText` is only in the answer; it is vaulted at once. */
export async function addPassword(http: CloudHttp, graphUrl: string, token: string, clientId: string, o: { displayName: string; endsAt: number }): Promise<{ keyId: string; secretText: string; endsAt: number }> {
  const b = await graph(http, graphUrl, token, `${appPath(clientId)}/addPassword`, { passwordCredential: { displayName: o.displayName, endDateTime: new Date(o.endsAt).toISOString() } });
  if (typeof b.keyId !== 'string' || typeof b.secretText !== 'string') throw new CloudCallError('Microsoft Graph answered addPassword without a secret.', 502, 'malformed');
  const end = typeof b.endDateTime === 'string' ? Date.parse(b.endDateTime) : o.endsAt;
  return { keyId: b.keyId, secretText: b.secretText, endsAt: Number.isFinite(end) ? end : o.endsAt };
}

export async function removePassword(http: CloudHttp, graphUrl: string, token: string, clientId: string, keyId: string): Promise<void> {
  await graph(http, graphUrl, token, `${appPath(clientId)}/removePassword`, { keyId });
}

/** The app registration's client secrets: key ids, hints (first characters) and end dates, never the secrets. */
export async function listPasswords(http: CloudHttp, graphUrl: string, token: string, clientId: string): Promise<{ keyId: string; hint: string | null; endsAt: number | null }[]> {
  const res = await http.request({ method: 'GET', url: `${trimBase(graphUrl)}/v1.0${appPath(clientId)}?$select=id,appId,passwordCredentials`, headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (res.status !== 200) throw new CloudCallError(`Microsoft Graph refused to list the app's secrets (HTTP ${res.status}).`, res.status === 403 || res.status === 401 ? 403 : 502, String(res.status));
  const b = JSON.parse(res.body.toString('utf8')) as { passwordCredentials?: { keyId?: string; hint?: string | null; endDateTime?: string | null }[] };
  return (b.passwordCredentials ?? []).filter((p) => typeof p.keyId === 'string').map((p) => ({ keyId: p.keyId!, hint: p.hint ?? null, endsAt: p.endDateTime ? Date.parse(p.endDateTime) : null }));
}
