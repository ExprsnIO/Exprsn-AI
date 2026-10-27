import { describe, expect, it } from 'vitest';
import { MfaService } from '../src/identity/mfa.js';

// 2026-10-16: a passkey is made and used on the origin of the page asking when that origin is one the console is
// served from (PUBLIC_URL, TRUSTED_ORIGINS) and a secure context; otherwise on PUBLIC_URL's origin, as before.
const make = (rpId = 'localhost', origins = ['http://localhost:8091', 'https://ai.ricksmacstudio.lan', 'http://ai.exprsn.local', 'https://ai.exprsn.local', 'http://127.0.0.1:8091']) =>
  new MfaService(null as never, null as never, { issuer: 'Exprsn-AI', rpId, rpName: 'Exprsn-AI', origin: origins[0]!, origins, secret: 'x'.repeat(32) });

describe('passkey relying party per origin', () => {
  it('uses the requesting trusted, secure origin and its host', () => {
    const m = make();
    expect(m.relyingParty('https://ai.ricksmacstudio.lan')).toEqual({ origin: 'https://ai.ricksmacstudio.lan', rpId: 'ai.ricksmacstudio.lan' });
    expect(m.relyingParty('https://ai.exprsn.local')).toEqual({ origin: 'https://ai.exprsn.local', rpId: 'ai.exprsn.local' });
    expect(m.relyingParty('http://127.0.0.1:8091')).toEqual({ origin: 'http://127.0.0.1:8091', rpId: '127.0.0.1' });
  });

  it('falls back to PUBLIC_URL for no origin, an untrusted origin, or plain http on a network name', () => {
    const m = make();
    const fallback = { origin: 'http://localhost:8091', rpId: 'localhost' };
    expect(m.relyingParty(null)).toEqual(fallback);
    expect(m.relyingParty(undefined)).toEqual(fallback);
    expect(m.relyingParty('http://localhost:8091')).toEqual(fallback);
    expect(m.relyingParty('https://evil.example')).toEqual(fallback);
    expect(m.relyingParty('http://ai.exprsn.local')).toEqual(fallback);
    expect(m.relyingParty('not a url')).toEqual(fallback);
  });

  it('keeps an explicit WEBAUTHN_RP_ID that is a parent domain of the host', () => {
    const m = make('ricksmacstudio.lan', ['https://ricksmacstudio.lan', 'https://ai.ricksmacstudio.lan', 'https://ai.exprsn.local']);
    expect(m.relyingParty('https://ai.ricksmacstudio.lan')).toEqual({ origin: 'https://ai.ricksmacstudio.lan', rpId: 'ricksmacstudio.lan' });
    expect(m.relyingParty('https://ai.exprsn.local')).toEqual({ origin: 'https://ai.exprsn.local', rpId: 'ai.exprsn.local' });
  });
});
