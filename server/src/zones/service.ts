import type { Services } from '../services.js';
import type { Scheduler } from '../platform/jobs.js';

type Tenants = () => Promise<{ tenantId: string; payload: Record<string, unknown> }[]>;

/** Sprint 9: network zones, ceilings, peers, proposals and rendered configuration. Reads its collaborators through `s` so later replacements (tests, overrides) are used. */
export class ZoneService {
  constructor(private readonly s: () => Services) {}

  /** Registers this area's job handlers on `s.jobs`. */
  registerJobs(): void {}

  /** Adds this area's recurring schedules. */
  schedule(_scheduler: Scheduler, _activeTenants: Tenants): void {}
}
