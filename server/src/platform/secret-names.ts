/*
 * Names whose values are credentials, shared by the outbound HTTP callers that keep credentials out of what they
 * store: registry HTTP tools (B-89) and workflow HTTP steps (B-9102). A value under such a name is a vault reference,
 * never a literal.
 */

/** Headers whose values are credentials: they take a vault reference only. */
export const SECRET_HEADER = /^(authorization|proxy-authorization|cookie)$|(token|secret|api-?key|apikey|password|passwd|signature|session|auth)/i;
/** Query parameters and body fields whose values are credentials. */
export const SECRET_FIELD = /(^|[_.-])(key|apikey|api_key|token|access_token|secret|client_secret|password|passwd|pwd|auth|authorization|signature|sig|credential|credentials|session)([_.-]|$)|apikey|accesstoken|clientsecret/i;
