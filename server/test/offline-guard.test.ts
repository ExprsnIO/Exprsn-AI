import { describe, expect, it } from 'vitest';
import { guardedRequest, serviceLookup, servicePolicy, ServiceUrlRefused } from '../src/platform/egress.js';

// 2026-10-20: tests never reach a real cloud provider. setup-offline.ts sets EXPRSN_TESTS_OFFLINE, and guardedRequest
// refuses the providers' API hosts before resolving them (a missing fake endpoint once sent requests to ECS and EKS).
describe('offline guard for cloud provider hosts in tests', () => {
  it('is on for every test run', () => {
    expect(process.env.EXPRSN_TESTS_OFFLINE).toBe('1');
  });

  for (const url of ['https://ecs.eu-central-1.amazonaws.com/', 'https://management.azure.com/subscriptions', 'https://api.digitalocean.com/v2/account', 'https://api.cloudflare.com/client/v4/user/tokens/verify', 'https://eks.us-east-1.amazonaws.com/clusters', 'https://exprsn.openai.azure.com/openai/deployments/x/chat/completions', 'https://exprsn.services.ai.azure.com/models', 'https://inference.do-ai.run/v1/models', 'https://abc.agents.do-ai.run/api/v1/chat/completions', 'https://api.cloudflare.com/client/v4/accounts/x/ai/v1/models']) {
    it(`refuses ${new URL(url).hostname} before any lookup`, async () => {
      const err = await guardedRequest({ url: new URL(url), method: 'GET', headers: {}, timeoutMs: 1000, check: () => null } as never).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUrlRefused);
      expect(String((err as Error).message)).toMatch(/real cloud host blocked in tests/);
    });
  }

  // 1.9.99-final, Sprint 60: the Chat Completions client dials through `serviceLookup`, which refuses them too.
  it('refuses cloud model hosts in the connect-time lookup', async () => {
    for (const host of ['exprsn.openai.azure.com', 'inference.do-ai.run', 'api.cloudflare.com']) {
      const err = await new Promise<unknown>((resolve) => serviceLookup(servicePolicy())(host, {}, (e) => resolve(e)));
      expect(String((err as Error).message)).toMatch(/real cloud host blocked in tests/);
    }
  });
});
