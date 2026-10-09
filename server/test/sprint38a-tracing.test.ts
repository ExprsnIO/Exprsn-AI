import { afterEach, describe, expect, it } from 'vitest';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';
import { FakeCollector } from './sprint22-fakes.js';

async function until<T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('B-7403: GenAI semantic-convention attributes on model spans', () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  it('the chat stream span carries gen_ai.usage.input_tokens and output_tokens, the provider and the model', async () => {
    const collector = await new FakeCollector().start();
    const ollama = await new FakeOllama().start();
    const h: Harness = await harness({ OLLAMA_POLL_MS: '600000', OTEL_EXPORTER_OTLP_ENDPOINT: collector.url, OTEL_BSP_SCHEDULE_DELAY: '50' });
    cleanup.push(() => collector.stop(), () => ollama.stop(), () => h.close());
    await seedGateway(h, ollama);
    await localUser(h, 'mem', ['member'], 'confidential');
    const m = await login(h, 'mem');
    const sent = await m.agent.post('/api/chat').set('x-csrf-token', m.csrf).send({ content: 'How many tokens is this?', profile: 'general' }).expect(202);
    await until(async () => (await h.s.db('messages').where({ id: sent.body.messageId }).first())?.completed_at);
    await h.s.tracer.flush();
    const span = (await until(async () => {
      await h.s.tracer.flush();
      return collector.spans().find((s) => s.name === 'gateway chat stream');
    }))!;
    const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
    expect(attrs['gen_ai.operation.name']).toEqual({ stringValue: 'chat' });
    expect(attrs['gen_ai.provider.name']).toEqual({ stringValue: 'ollama' });
    expect(attrs['gen_ai.request.model']).toEqual({ stringValue: 'llama3.1:8b' });
    expect(attrs['gen_ai.response.model']).toEqual({ stringValue: 'llama3.1:8b' });
    const n = (v: Record<string, unknown> | undefined) => Number((v as { intValue?: string | number })?.intValue);
    expect(n(attrs['gen_ai.usage.input_tokens'])).toBeGreaterThan(0);
    expect(n(attrs['gen_ai.usage.output_tokens'])).toBeGreaterThan(0);
    // The same figures the meter recorded.
    const usage = await h.s.db('usage_records').where({ tenant_id: h.tenantId, kind: 'chat' }).first();
    expect(n(attrs['gen_ai.usage.input_tokens'])).toBe(Number(usage!.prompt_tokens));
    expect(n(attrs['gen_ai.usage.output_tokens'])).toBe(Number(usage!.output_tokens));
    // Still no message text in what was exported.
    expect(collector.bodies.join('\n')).not.toContain('How many tokens');
  });
});
