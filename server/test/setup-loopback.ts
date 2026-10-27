import { vi } from 'vitest';
import type supertest from 'supertest';
import { loopbackServerFor } from './loopback.js';

// `request(app)` and `request.agent(app)` use the app's loopback server when the harness registered one (loopback.ts).
vi.mock('supertest', async (importOriginal) => {
  const original = (await importOriginal<{ default: typeof supertest }>()).default;
  const wrap = ((app: unknown, options?: unknown) => original((loopbackServerFor(app) ?? app) as never, options as never)) as typeof original;
  const agent = ((app: unknown, options?: unknown) => original.agent((loopbackServerFor(app) ?? app) as never, options as never)) as typeof original.agent;
  Object.assign(wrap, original, { agent });
  return { default: wrap };
});
