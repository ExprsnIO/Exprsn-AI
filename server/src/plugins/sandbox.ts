import { BROKER_MARK } from '../scripts/runner.js';

/*
 * The program a script plugin's handler runs as in the sandbox (B-2004), after exprsn-platform's worker sandbox, whose
 * host proxied every `platform.*` call over a message channel. Here the handler runs in the script sandbox (a
 * disposable container with no network, never in this process), and the channel is the container's stdin and stdout:
 *
 *   host -> handler   one line: {t: 'hello', token, event, config, plugin, maxCalls}
 *   handler -> host   `BROKER_MARK` + {t: 'call', id, token, api, args}      (one at a time)
 *   host -> handler   one line: {t: 'result', id, status, body?, detail?}
 *   handler -> host   `BROKER_MARK` + {t: 'done', result?} or {t: 'done', error, status?}
 *
 * The token is the invocation's scoped token: the host checks it, and the call against the plugin's grants, on every
 * call (an ungranted API answers 403, which the handler sees as a thrown error with `status`). The prelude only
 * frames messages; it holds no other power, and anything else the handler prints is kept as its log.
 *
 * The handler is the function `script.entry` the source declares, called as `entry(event, platform)`, where
 * `platform.call(api, args)` makes a brokered call and `platform.log(message, level?)` is `call('log', …)`.
 */

export type ScriptLanguage = 'javascript' | 'python';

const jsPrelude = (mark: string) => `import { createInterface as __exaiReadline } from 'node:readline';
const __exai = await (async () => {
  const mark = ${JSON.stringify(mark)};
  const lines = __exaiReadline({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const next = async () => {
    const r = await lines.next();
    if (r.done) throw new Error('The host closed the channel.');
    return JSON.parse(r.value);
  };
  const send = (m) => new Promise((ok) => process.stdout.write(mark + JSON.stringify(m) + '\\n', ok));
  const hello = await next();
  let n = 0;
  let busy = false;
  const call = async (api, args = {}) => {
    if (busy) throw new Error('One platform call at a time: await each call before the next.');
    busy = true;
    try {
      const id = ++n;
      await send({ t: 'call', id, token: hello.token, api: String(api), args: args ?? {} });
      const r = await next();
      if (r.id !== id) throw new Error('The host answered out of turn.');
      if (r.status >= 400) {
        const e = new Error(r.detail || ('The platform answered ' + r.status + '.'));
        e.status = r.status;
        throw e;
      }
      return r.body;
    } finally {
      busy = false;
    }
  };
  const platform = Object.freeze({ event: hello.event, config: hello.config, plugin: hello.plugin, call, log: (message, level = 'info') => call('log', { message: String(message), level }) });
  return { hello, send, platform };
})();
`;

const jsEpilogue = (entry: string) => `
;try {
  const __exaiResult = await ${entry}(__exai.hello.event, __exai.platform);
  await __exai.send({ t: 'done', result: __exaiResult === undefined ? null : __exaiResult });
  process.exit(0);
} catch (e) {
  await __exai.send({ t: 'done', error: String((e && e.message) || e), status: (e && e.status) || null });
  process.exit(1);
}
`;

const pyPrelude = (mark: string) => `import sys as _exai_sys, json as _exai_json
_exai_mark = ${JSON.stringify(mark)}
def _exai_send(m):
    _exai_sys.stdout.write(_exai_mark + _exai_json.dumps(m) + "\\n")
    _exai_sys.stdout.flush()
def _exai_next():
    line = _exai_sys.stdin.readline()
    if not line:
        raise RuntimeError("The host closed the channel.")
    return _exai_json.loads(line)
class PlatformError(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status = status
_exai_hello = _exai_next()
class _ExaiPlatform:
    def __init__(self, hello):
        self.event = hello.get("event")
        self.config = hello.get("config")
        self.plugin = hello.get("plugin")
        self._n = 0
    def call(self, api, args=None):
        self._n += 1
        _exai_send({"t": "call", "id": self._n, "token": _exai_hello["token"], "api": str(api), "args": args or {}})
        r = _exai_next()
        if r.get("id") != self._n:
            raise RuntimeError("The host answered out of turn.")
        if r.get("status", 500) >= 400:
            raise PlatformError(r.get("status"), r.get("detail") or "The platform answered %s." % r.get("status"))
        return r.get("body")
    def log(self, message, level="info"):
        return self.call("log", {"message": str(message), "level": level})
platform = _ExaiPlatform(_exai_hello)
`;

const pyEpilogue = (entry: string) => `
try:
    _exai_result = ${entry}(_exai_hello.get("event"), platform)
    _exai_send({"t": "done", "result": _exai_result})
except Exception as _exai_e:
    _exai_send({"t": "done", "error": str(_exai_e), "status": getattr(_exai_e, "status", None)})
    _exai_sys.exit(1)
`;

/** The program the sandbox runs: the prelude, the plugin's source, then the call of its entry function. */
export function handlerProgram(language: ScriptLanguage, source: string, entry: string): string {
  return language === 'python' ? `${pyPrelude(BROKER_MARK)}\n${source}\n${pyEpilogue(entry)}` : `${jsPrelude(BROKER_MARK)}\n${source}\n${jsEpilogue(entry)}`;
}

export interface BrokerCallMessage {
  t: 'call';
  id: number;
  token: string;
  api: string;
  args: Record<string, unknown>;
}

export interface BrokerDoneMessage {
  t: 'done';
  result?: unknown;
  error?: string;
  status?: number | null;
}

export const isCall = (m: unknown): m is BrokerCallMessage => typeof m === 'object' && m !== null && (m as { t?: unknown }).t === 'call' && typeof (m as { id?: unknown }).id === 'number';
export const isDone = (m: unknown): m is BrokerDoneMessage => typeof m === 'object' && m !== null && (m as { t?: unknown }).t === 'done';
