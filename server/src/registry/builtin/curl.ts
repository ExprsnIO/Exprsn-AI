/*
 * Migration 048: a `curl` or `wget` command line read as a request, for the built-ins `http_fetch`, `http_request`
 * and `http_download`. Nothing is executed: the command is split into words the way a shell would (quotes and
 * backslashes only; no variables, substitutions, pipes or redirections) and its options become a method, a URL,
 * headers and a body. An option that cannot be honoured (a file to upload, a certificate check to skip, a recursive
 * download) is refused by name instead of being dropped, so a command never does less than it says without saying so.
 */

export class CommandRefused extends Error {}

export interface ParsedCommand {
  tool: 'curl' | 'wget';
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** curl follows redirects only with -L; wget follows them by default. */
  followRedirects: boolean;
  maxRedirects?: number;
  /** -o / -O: the name the answer is saved under (`http_download`). */
  output?: string;
  timeoutSeconds?: number;
  /** -I / --spider: the headers are what is asked for. */
  headOnly: boolean;
  /** What was accepted and has no effect here. */
  notes: string[];
}

/** Splits a command line into words: single and double quotes, backslash escapes, `$'...'`, line continuations. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  const n = line.length;
  const refuse = (what: string): never => {
    throw new CommandRefused(`The command uses ${what}, which is not run here: give one plain curl or wget command with its values written out.`);
  };
  while (i < n) {
    const c = line[i]!;
    if (c === '\\' && line[i + 1] === '\n') i += 2;
    else if (c === '\\' && line[i + 1] === '\r' && line[i + 2] === '\n') i += 3;
    else if (/\s/.test(c)) {
      if (has) words.push(cur);
      cur = '';
      has = false;
      i++;
    } else if (c === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) throw new CommandRefused('A single quote in the command is not closed.');
      cur += line.slice(i + 1, j);
      has = true;
      i = j + 1;
    } else if (c === '$' && line[i + 1] === "'") {
      let j = i + 2;
      let out = '';
      const esc: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v', 0: '\0' };
      while (j < n && line[j] !== "'") {
        if (line[j] === '\\' && j + 1 < n) {
          out += esc[line[j + 1]!] ?? line[j + 1]!;
          j += 2;
        } else out += line[j++]!;
      }
      if (j >= n) throw new CommandRefused("A $'...' quote in the command is not closed.");
      cur += out;
      has = true;
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && line[j] !== '"') {
        const d = line[j]!;
        if (d === '\\' && j + 1 < n && '"\\$`\n'.includes(line[j + 1]!)) {
          if (line[j + 1] !== '\n') out += line[j + 1]!;
          j += 2;
        } else if (d === '$' && /[A-Za-z_{(]/.test(line[j + 1] ?? '')) refuse('a shell variable or substitution ($...)');
        else if (d === '`') refuse('a command substitution (`...`)');
        else out += line[j++]!;
      }
      if (j >= n) throw new CommandRefused('A double quote in the command is not closed.');
      cur += out;
      has = true;
      i = j + 1;
    } else if (c === '\\') {
      if (i + 1 < n) cur += line[i + 1]!;
      has = true;
      i += 2;
    } else if (c === '$' && /[A-Za-z_{(]/.test(line[i + 1] ?? '')) refuse('a shell variable or substitution ($...)');
    else if (c === '`') refuse('a command substitution (`...`)');
    else if (c === '|' || c === ';' || c === '>' || c === '<' || (c === '&' && !has)) refuse(`the shell operator ${c}`);
    else if (c === '&' && (i + 1 >= n || /\s|&/.test(line[i + 1]!))) refuse('the shell operator &');
    else {
      cur += c;
      has = true;
      i++;
    }
  }
  if (has) words.push(cur);
  return words;
}

const basic = (userPass: string): string => `Basic ${Buffer.from(userPass, 'utf8').toString('base64')}`;
const setHeader = (headers: Record<string, string>, line: string): void => {
  const m = /^([^:;]+)\s*[:;]\s*(.*)$/s.exec(line);
  if (!m) throw new CommandRefused(`The header ${JSON.stringify(line)} is not of the form Name: value.`);
  const name = m[1]!.trim().toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new CommandRefused(`${JSON.stringify(m[1])} is not a header name.`);
  if (m[2]!.trim() === '') delete headers[name];
  else headers[name] = m[2]!.trim();
};
const seconds = (v: string, opt: string): number => {
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) throw new CommandRefused(`${opt} takes a number of seconds.`);
  return x;
};
const noFile = (v: string, opt: string): string => {
  if (v.startsWith('@')) throw new CommandRefused(`${opt} ${v} reads a file from disk, which is not available here: give the content itself.`);
  return v;
};
const fileName = (url: string): string | undefined => {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    return last || undefined;
  } catch {
    return undefined;
  }
};

/** curl options that take a value, by their long name; the short forms map onto them. */
const CURL_SHORT: Record<string, string> = { X: 'request', H: 'header', d: 'data', A: 'user-agent', e: 'referer', b: 'cookie', u: 'user', o: 'output', m: 'max-time', F: 'form', T: 'upload-file', x: 'proxy', E: 'cert', K: 'config', c: 'cookie-jar', D: 'dump-header', w: 'write-out', r: 'range', z: 'time-cond', Y: 'speed-limit', y: 'speed-time', C: 'continue-at' };
const CURL_VALUE = new Set(['request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json', 'user-agent', 'referer', 'cookie', 'user', 'output', 'max-time', 'connect-timeout', 'max-redirs', 'url', 'form', 'form-string', 'upload-file', 'proxy', 'cert', 'key', 'cacert', 'config', 'cookie-jar', 'dump-header', 'write-out', 'range', 'time-cond', 'resolve', 'connect-to', 'interface', 'retry', 'retry-delay', 'retry-max-time', 'oauth2-bearer', 'speed-limit', 'speed-time', 'continue-at', 'limit-rate', 'unix-socket', 'proxy-user', 'output-dir', 'http-version']);
/** Accepted and without effect: how curl reports, not what it asks for. */
const CURL_IGNORED = new Set(['silent', 'show-error', 'verbose', 'include', 'compressed', 'fail', 'fail-with-body', 'no-progress-meter', 'progress-bar', 'globoff', 'http1.1', 'http2', 'no-buffer', 'tcp-nodelay', 'no-keepalive', 'styled-output', 'ipv4', 'ipv6', 'path-as-is', 'tlsv1.2', 'tlsv1.3', 'ssl-reqd', 'location-trusted', 'create-dirs', 'remote-header-name', 'no-clobber']);
const CURL_SHORT_FLAGS: Record<string, string> = { s: 'silent', S: 'show-error', v: 'verbose', i: 'include', f: 'fail', L: 'location', I: 'head', G: 'get', k: 'insecure', O: 'remote-name', '#': 'progress-bar', g: 'globoff', N: 'no-buffer', J: 'remote-header-name', 4: 'ipv4', 6: 'ipv6', n: 'netrc', q: 'disable', Z: 'parallel' };
const CURL_REFUSED: Record<string, string> = {
  insecure: 'skips the certificate check, which is never done here',
  form: 'sends a multipart form, which is not supported: send JSON or URL-encoded data',
  'form-string': 'sends a multipart form, which is not supported: send JSON or URL-encoded data',
  'upload-file': 'uploads a file from disk, which is not available here',
  proxy: 'goes through a proxy, which is not allowed: requests leave through the outbound address guard',
  'proxy-user': 'goes through a proxy, which is not allowed',
  cert: 'uses a client certificate from disk, which is not available here',
  key: 'uses a key from disk, which is not available here',
  cacert: 'changes the trusted authorities, which is not allowed',
  config: 'reads options from a file, which is not available here',
  'cookie-jar': 'writes a cookie file, which is not available here',
  'dump-header': 'writes a file, which is not available here',
  resolve: 'overrides name resolution, which would go around the outbound address guard',
  'connect-to': 'overrides the address, which would go around the outbound address guard',
  interface: 'chooses a network interface, which is not allowed',
  'unix-socket': 'connects to a local socket, which is not allowed',
  netrc: 'reads credentials from a file, which is not available here',
  parallel: 'asks for several transfers at once: give one URL per call',
  'continue-at': 'resumes a partial file, which is not supported',
  range: 'asks for a part of the file: give the header Range yourself with -H if the server supports it'
};

function curl(words: string[]): ParsedCommand {
  const out: ParsedCommand = { tool: 'curl', method: '', url: '', headers: {}, followRedirects: false, headOnly: false, notes: [] };
  const data: string[] = [];
  let get = false;
  let json = false;
  let remoteName = false;
  const urls: string[] = [];
  const apply = (name: string, value: string | null): void => {
    if (CURL_REFUSED[name]) throw new CommandRefused(`curl --${name} ${CURL_REFUSED[name]}.`);
    switch (name) {
      case 'request':
        out.method = value!.toUpperCase();
        break;
      case 'header':
        setHeader(out.headers, noFile(value!, '-H'));
        break;
      case 'data':
      case 'data-ascii':
        data.push(noFile(value!, '--data').replace(/[\r\n]/g, ''));
        break;
      case 'data-raw':
        data.push(value!);
        break;
      case 'data-binary':
        data.push(noFile(value!, '--data-binary'));
        break;
      case 'data-urlencode': {
        const v = value!;
        if (/^[^=@]*@/.test(v)) throw new CommandRefused('--data-urlencode with @file reads a file from disk, which is not available here.');
        const eq = v.indexOf('=');
        data.push(eq < 0 ? encodeURIComponent(v) : eq === 0 ? encodeURIComponent(v.slice(1)) : `${v.slice(0, eq)}=${encodeURIComponent(v.slice(eq + 1))}`);
        break;
      }
      case 'json':
        data.push(noFile(value!, '--json'));
        json = true;
        break;
      case 'user-agent':
        out.headers['user-agent'] = value!;
        break;
      case 'referer':
        out.headers.referer = value!.replace(/;auto$/, '');
        break;
      case 'cookie':
        if (!value!.includes('=')) throw new CommandRefused(`curl -b ${value} reads cookies from a file, which is not available here: give them as name=value.`);
        out.headers.cookie = value!;
        break;
      case 'user':
        if (!value!.includes(':')) throw new CommandRefused('curl -u needs user:password here (it cannot prompt for the password).');
        out.headers.authorization = basic(value!);
        break;
      case 'oauth2-bearer':
        out.headers.authorization = `Bearer ${value}`;
        break;
      case 'output':
        if (value !== '-' && value !== '/dev/null') out.output = value!.split('/').pop() || undefined;
        break;
      case 'remote-name':
        remoteName = true;
        break;
      case 'max-time':
        out.timeoutSeconds = seconds(value!, '--max-time');
        break;
      case 'max-redirs':
        out.maxRedirects = Math.max(0, Math.trunc(Number(value)));
        break;
      case 'location':
        out.followRedirects = true;
        break;
      case 'head':
        out.headOnly = true;
        break;
      case 'get':
        get = true;
        break;
      case 'url':
        urls.push(value!);
        break;
      case 'connect-timeout':
      case 'retry':
      case 'retry-delay':
      case 'retry-max-time':
      case 'write-out':
      case 'time-cond':
      case 'speed-limit':
      case 'speed-time':
      case 'limit-rate':
      case 'output-dir':
      case 'http-version':
        out.notes.push(`--${name} has no effect here.`);
        break;
      default:
        if (CURL_IGNORED.has(name)) break;
        throw new CommandRefused(`curl --${name} is not supported here. Supported: -X, -H, -d, --data-raw, --data-binary, --data-urlencode, --json, -G, -I, -L, --max-redirs, -A, -e, -b name=value, -u user:password, --oauth2-bearer, -o, -O, -m.`);
    }
  };
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith('--') && w.length > 2) {
      const eq = w.indexOf('=');
      const name = eq > 0 ? w.slice(2, eq) : w.slice(2);
      if (CURL_VALUE.has(name)) {
        const value = eq > 0 ? w.slice(eq + 1) : words[++i];
        if (value === undefined) throw new CommandRefused(`curl --${name} needs a value.`);
        apply(name, value);
      } else apply(name, null);
    } else if (w.startsWith('-') && w.length > 1) {
      for (let k = 1; k < w.length; k++) {
        const ch = w[k]!;
        const long = CURL_SHORT[ch];
        if (long) {
          const value = k + 1 < w.length ? w.slice(k + 1) : words[++i];
          if (value === undefined) throw new CommandRefused(`curl -${ch} needs a value.`);
          apply(long, value);
          break;
        }
        const flag = CURL_SHORT_FLAGS[ch];
        if (!flag) throw new CommandRefused(`curl -${ch} is not supported here.`);
        apply(flag, null);
      }
    } else urls.push(w);
  }
  if (!urls.length) throw new CommandRefused('The curl command has no URL.');
  if (urls.length > 1) throw new CommandRefused(`The curl command names ${urls.length} URLs: give one per call.`);
  out.url = /^[a-z][a-z0-9+.-]*:\/\//i.test(urls[0]!) ? urls[0]! : `http://${urls[0]!}`;
  if (data.length) {
    const joined = json ? data.join('') : data.join('&');
    if (get) {
      const u = new URL(out.url);
      u.search = u.search ? `${u.search}&${joined}` : `?${joined}`;
      out.url = u.toString();
    } else {
      out.body = joined;
      out.headers['content-type'] ??= json ? 'application/json' : 'application/x-www-form-urlencoded';
      if (json) out.headers.accept ??= 'application/json';
    }
  }
  if (!out.method) out.method = out.headOnly ? 'HEAD' : out.body !== undefined ? 'POST' : 'GET';
  if (remoteName && !out.output) {
    const nameFromUrl = fileName(out.url);
    if (nameFromUrl) out.output = nameFromUrl;
  }
  return out;
}

const WGET_VALUE = new Set(['output-document', 'header', 'post-data', 'body-data', 'method', 'user-agent', 'referer', 'timeout', 'read-timeout', 'connect-timeout', 'dns-timeout', 'max-redirect', 'user', 'password', 'http-user', 'http-password', 'tries', 'wait', 'waitretry', 'limit-rate', 'directory-prefix', 'output-file', 'append-output', 'input-file', 'post-file', 'body-file', 'load-cookies', 'save-cookies', 'ca-certificate', 'certificate', 'private-key', 'level', 'accept', 'reject', 'domains', 'quota', 'bind-address', 'execute']);
const WGET_SHORT: Record<string, string> = { O: 'output-document', U: 'user-agent', T: 'timeout', t: 'tries', w: 'wait', P: 'directory-prefix', o: 'output-file', a: 'append-output', i: 'input-file', l: 'level', A: 'accept', R: 'reject', D: 'domains', Q: 'quota', e: 'execute' };
const WGET_SHORT_FLAGS: Record<string, string> = { q: 'quiet', v: 'verbose', c: 'continue', S: 'server-response', r: 'recursive', m: 'mirror', N: 'timestamping', p: 'page-requisites', k: 'convert-links', b: 'background', 4: 'inet4-only', 6: 'inet6-only', n: 'n' };
const WGET_IGNORED = new Set(['quiet', 'verbose', 'no-verbose', 'server-response', 'show-progress', 'no-clobber', 'timestamping', 'inet4-only', 'inet6-only', 'content-disposition', 'trust-server-names', 'compression', 'no-hsts', 'no-cache', 'no-cookies', 'https-only']);
const WGET_REFUSED: Record<string, string> = {
  recursive: 'downloads a whole site: fetch one URL per call, or add the site to a knowledge base as a web source',
  mirror: 'downloads a whole site: fetch one URL per call, or add the site to a knowledge base as a web source',
  'page-requisites': 'downloads the files a page refers to: fetch one URL per call',
  'convert-links': 'rewrites downloaded pages, which goes with recursive downloads',
  'input-file': 'reads URLs from a file, which is not available here: give one URL per call',
  'post-file': 'sends a file from disk, which is not available here: give the content with --post-data',
  'body-file': 'sends a file from disk, which is not available here: give the content with --body-data',
  'no-check-certificate': 'skips the certificate check, which is never done here',
  'load-cookies': 'reads a cookie file, which is not available here',
  'save-cookies': 'writes a cookie file, which is not available here',
  'ca-certificate': 'changes the trusted authorities, which is not allowed',
  certificate: 'uses a client certificate from disk, which is not available here',
  'private-key': 'uses a key from disk, which is not available here',
  background: 'runs in the background, which is not possible here',
  continue: 'resumes a partial file, which is not supported',
  execute: 'runs a wgetrc command, which is not allowed',
  'bind-address': 'chooses a network address, which is not allowed',
  spider: ''
};

function wget(words: string[]): ParsedCommand {
  const out: ParsedCommand = { tool: 'wget', method: '', url: '', headers: {}, followRedirects: true, headOnly: false, notes: [] };
  const urls: string[] = [];
  let user: string | undefined;
  let password = '';
  const apply = (name: string, value: string | null): void => {
    if (name === 'spider') {
      out.headOnly = true;
      return;
    }
    if (WGET_REFUSED[name]) throw new CommandRefused(`wget --${name} ${WGET_REFUSED[name]}.`);
    switch (name) {
      case 'output-document':
        if (value !== '-' && value !== '/dev/null') out.output = value!.split('/').pop() || undefined;
        break;
      case 'header':
        setHeader(out.headers, value!);
        break;
      case 'post-data':
        out.body = value!;
        out.method ||= 'POST';
        out.headers['content-type'] ??= 'application/x-www-form-urlencoded';
        break;
      case 'body-data':
        out.body = value!;
        break;
      case 'method':
        out.method = value!.toUpperCase();
        break;
      case 'user-agent':
        out.headers['user-agent'] = value!;
        break;
      case 'referer':
        out.headers.referer = value!;
        break;
      case 'timeout':
      case 'read-timeout':
        out.timeoutSeconds = seconds(value!, `--${name}`);
        break;
      case 'max-redirect':
        out.maxRedirects = Math.max(0, Math.trunc(Number(value)));
        if (out.maxRedirects === 0) out.followRedirects = false;
        break;
      case 'user':
      case 'http-user':
        user = value!;
        break;
      case 'password':
      case 'http-password':
        password = value!;
        break;
      case 'n':
        break;
      default:
        if (WGET_IGNORED.has(name)) break;
        if (WGET_VALUE.has(name)) {
          out.notes.push(`--${name} has no effect here.`);
          break;
        }
        throw new CommandRefused(`wget --${name} is not supported here. Supported: -O, --header, --post-data, --method, --body-data, -U, --referer, -T, --max-redirect, --user and --password, --spider.`);
    }
  };
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith('--') && w.length > 2) {
      const eq = w.indexOf('=');
      const name = eq > 0 ? w.slice(2, eq) : w.slice(2);
      if (WGET_VALUE.has(name)) {
        const value = eq > 0 ? w.slice(eq + 1) : words[++i];
        if (value === undefined) throw new CommandRefused(`wget --${name} needs a value.`);
        apply(name, value);
      } else apply(name, null);
    } else if (w.startsWith('-') && w.length > 1) {
      // -nv, -nc, -nd and the like are two-letter options of their own.
      if (/^-n[a-zA-Z]$/.test(w)) {
        if (w === '-nv' || w === '-nc' || w === '-nd' || w === '-nH') continue;
        throw new CommandRefused(`wget ${w} is not supported here.`);
      }
      for (let k = 1; k < w.length; k++) {
        const ch = w[k]!;
        const long = WGET_SHORT[ch];
        if (long) {
          const value = k + 1 < w.length ? w.slice(k + 1) : words[++i];
          if (value === undefined) throw new CommandRefused(`wget -${ch} needs a value.`);
          apply(long, value);
          break;
        }
        const flag = WGET_SHORT_FLAGS[ch];
        if (!flag) throw new CommandRefused(`wget -${ch} is not supported here.`);
        apply(flag, null);
      }
    } else urls.push(w);
  }
  if (!urls.length) throw new CommandRefused('The wget command has no URL.');
  if (urls.length > 1) throw new CommandRefused(`The wget command names ${urls.length} URLs: give one per call.`);
  out.url = /^[a-z][a-z0-9+.-]*:\/\//i.test(urls[0]!) ? urls[0]! : `http://${urls[0]!}`;
  if (user !== undefined) out.headers.authorization = basic(`${user}:${password}`);
  if (!out.method) out.method = out.headOnly ? 'HEAD' : 'GET';
  if (!out.output) {
    const nameFromUrl = fileName(out.url);
    if (nameFromUrl) out.output = nameFromUrl;
  }
  return out;
}

/** Reads one `curl ...` or `wget ...` command line as a request. Throws CommandRefused with the reason otherwise. */
export function parseFetchCommand(line: string): ParsedCommand {
  const words = shellWords(line.trim());
  if (!words.length) throw new CommandRefused('The command is empty.');
  const name = words[0]!.split('/').pop()!.toLowerCase();
  if (name === 'curl') return curl(words);
  if (name === 'wget') return wget(words);
  throw new CommandRefused(`The command starts with ${words[0]}: only curl and wget commands are read here.`);
}
