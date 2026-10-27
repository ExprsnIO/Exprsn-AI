import { createHash } from 'node:crypto';
import { signV4 } from '../platform/blob.js';
import { CloudCallError, form, xmlAll, xmlText, type CloudHttp } from './credential-http.js';

/*
 * 1.9.99-final, Sprint 56 (B-10003, B-10006): the few AWS calls credentials need, over the AWS Query API.
 *
 * - STS `AssumeRoleWithWebIdentity` (federation): not signed; the web identity token is the proof.
 * - STS `GetCallerIdentity` (a key or session is checked before it is switched to).
 * - IAM `CreateAccessKey`, `DeleteAccessKey`, `ListAccessKeys` (automatic rotation of a vaulted key).
 *
 * The endpoints are settings (CLOUD_AWS_STS_URL, CLOUD_AWS_IAM_URL), so the tests point them at the fake. Keys and
 * session tokens are only ever in the returned objects, never in an error message or a log line.
 */

export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsSession extends AwsKeys {
  sessionToken: string;
  expiresAt: number;
  /** The assumed role's ARN as STS reports it. */
  assumedRoleArn: string | null;
}

const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');

function awsError(service: string, status: number, body: string): CloudCallError {
  const code = xmlText(body, 'Code');
  const message = xmlText(body, 'Message');
  return new CloudCallError(`${service} refused the call${code ? ` (${code})` : ''}${message ? `: ${message.slice(0, 300)}` : ''}.`, status >= 400 && status < 500 ? (status === 403 ? 403 : 422) : 502, code);
}

async function signedQuery(http: CloudHttp, o: { url: string; service: string; region: string; keys: AwsKeys; params: Record<string, string> }): Promise<string> {
  const body = form(o.params);
  const url = new URL(o.url);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', ...(o.keys.sessionToken ? { 'x-amz-security-token': o.keys.sessionToken } : {}) };
  const signed = signV4({ method: 'POST', url, headers, payloadHash: sha256(body), region: o.region, service: o.service, accessKeyId: o.keys.accessKeyId, secretAccessKey: o.keys.secretAccessKey, date: new Date() });
  const res = await http.request({ method: 'POST', url, headers: signed, body });
  const text = res.body.toString('utf8');
  if (res.status !== 200) throw awsError(o.service === 'iam' ? 'IAM' : 'STS', res.status, text);
  return text;
}

/** One session for a role, bought with a token from Exprsn-AI's issuer. */
export async function assumeRoleWithWebIdentity(http: CloudHttp, stsUrl: string, o: { roleArn: string; token: string; sessionName: string; durationSeconds: number }): Promise<AwsSession> {
  const body = form({ Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: o.roleArn, RoleSessionName: o.sessionName, WebIdentityToken: o.token, DurationSeconds: String(o.durationSeconds) });
  const res = await http.request({ method: 'POST', url: stsUrl, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/xml' }, body });
  const text = res.body.toString('utf8');
  if (res.status !== 200) throw awsError('STS', res.status, text);
  const accessKeyId = xmlText(text, 'AccessKeyId');
  const secretAccessKey = xmlText(text, 'SecretAccessKey');
  const sessionToken = xmlText(text, 'SessionToken');
  const expiration = xmlText(text, 'Expiration');
  if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) throw new CloudCallError('STS answered without credentials.', 502, 'malformed');
  const expiresAt = Date.parse(expiration);
  if (!Number.isFinite(expiresAt)) throw new CloudCallError('STS answered with an unreadable expiry.', 502, 'malformed');
  return { accessKeyId, secretAccessKey, sessionToken, expiresAt, assumedRoleArn: xmlText(xmlText(text, 'AssumedRoleUser') ?? '', 'Arn') };
}

/** Who the keys are: the account and the ARN. */
export async function getCallerIdentity(http: CloudHttp, stsUrl: string, keys: AwsKeys): Promise<{ account: string | null; arn: string | null; userId: string | null }> {
  const text = await signedQuery(http, { url: stsUrl, service: 'sts', region: 'us-east-1', keys, params: { Action: 'GetCallerIdentity', Version: '2011-06-15' } });
  return { account: xmlText(text, 'Account'), arn: xmlText(text, 'Arn'), userId: xmlText(text, 'UserId') };
}

const iamParams = (action: string, userName: string | null, extra: Record<string, string> = {}) => ({ Action: action, Version: '2010-05-08', ...(userName ? { UserName: userName } : {}), ...extra });

/** A new access key for the user the keys belong to (or `userName`). */
export async function createAccessKey(http: CloudHttp, iamUrl: string, keys: AwsKeys, userName: string | null): Promise<{ accessKeyId: string; secretAccessKey: string; userName: string | null }> {
  const text = await signedQuery(http, { url: iamUrl, service: 'iam', region: 'us-east-1', keys, params: iamParams('CreateAccessKey', userName) });
  const accessKeyId = xmlText(text, 'AccessKeyId');
  const secretAccessKey = xmlText(text, 'SecretAccessKey');
  if (!accessKeyId || !secretAccessKey) throw new CloudCallError('IAM answered CreateAccessKey without a key.', 502, 'malformed');
  return { accessKeyId, secretAccessKey, userName: xmlText(text, 'UserName') };
}

export async function deleteAccessKey(http: CloudHttp, iamUrl: string, keys: AwsKeys, accessKeyId: string, userName: string | null): Promise<void> {
  await signedQuery(http, { url: iamUrl, service: 'iam', region: 'us-east-1', keys, params: iamParams('DeleteAccessKey', userName, { AccessKeyId: accessKeyId }) });
}

export async function listAccessKeys(http: CloudHttp, iamUrl: string, keys: AwsKeys, userName: string | null): Promise<{ accessKeyId: string; status: string }[]> {
  const text = await signedQuery(http, { url: iamUrl, service: 'iam', region: 'us-east-1', keys, params: iamParams('ListAccessKeys', userName) });
  return xmlAll(text, 'member').map((m) => ({ accessKeyId: xmlText(m, 'AccessKeyId') ?? '', status: xmlText(m, 'Status') ?? '' })).filter((k) => k.accessKeyId);
}

/** The IAM user name in a caller ARN (`arn:aws:iam::123456789012:user/path/name` → `name`), or null for a role. */
export function iamUserOf(arn: string | null): string | null {
  const m = /^arn:aws[a-z-]*:iam::\d{12}:user\/(?:.*\/)?([\w+=,.@-]{1,64})$/.exec(arn ?? '');
  return m ? m[1]! : null;
}
