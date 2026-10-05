import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { canonicalJson } from '../crypto/index.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { formDefinitionSchema } from './forms.js';
import { entityDefinitionSchema, nameSchema } from './schema.js';
import type { Actor, AppRow, AppService } from './service.js';

/*
 * App bundles (B-2208): an app's design (the app, its entities with fields and state machines, its forms) exported
 * as one JSON document and signed with an HMAC key held in the KMS (`<OPENBAO_KEY_PREFIX>app-bundles`). Records,
 * triggers (which name this installation's workflows and owners) and public form links are not part of a bundle.
 *
 * Import verifies the signature over the canonical JSON of everything but the signature before reading anything
 * else: a bundle changed in any byte after it was signed, signed with another key, or naming another key is refused
 * (422) and the refusal audited. So a bundle moves between workspaces, tenants and installations that share the KMS
 * key (the same DATA_KEY or OpenBao transit key); see docs/security.md for the gap across unrelated installations.
 */

export const BUNDLE_FORMAT = 'exprsn-app/1';

const entityPart = z.object({ name: nameSchema, title: z.string().min(1).max(200), label: z.enum(LABELS), definition: entityDefinitionSchema }).strict();
const formPart = z.object({ name: nameSchema, title: z.string().min(1).max(200), entity: nameSchema, definition: formDefinitionSchema, ratePerMinute: z.number().int().min(1).max(10_000) }).strict();

export const bundleSchema = z
  .object({
    format: z.literal(BUNDLE_FORMAT),
    exportedAt: z.string().max(40),
    app: z.object({ name: nameSchema, title: z.string().min(1).max(200), description: z.string().max(5000).nullable(), label: z.enum(LABELS) }).strict(),
    entities: z.array(entityPart).max(200),
    forms: z.array(formPart).max(500),
    key: z.string().max(200),
    signature: z.string().max(400)
  })
  .strict();
export type AppBundle = z.infer<typeof bundleSchema>;

export class AppBundles {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  get keyName(): string {
    return `${this.s().cfg.OPENBAO_KEY_PREFIX}app-bundles`;
  }

  async export(actor: Actor & { principal: Principal }, appRef: string): Promise<AppBundle> {
    const s = this.s();
    const app = await this.apps.app(actor.principal, appRef);
    const entities = await this.apps.entities(app);
    const byId = new Map(entities.map((e) => [e.id, e.name]));
    const forms = await this.apps.forms.list(app);
    const body: Omit<AppBundle, 'signature'> = {
      format: BUNDLE_FORMAT,
      exportedAt: new Date().toISOString(),
      app: { name: app.name, title: app.title, description: app.description, label: app.label },
      entities: entities.map((e) => ({ name: e.name, title: e.title, label: e.label, definition: e.definition })),
      forms: forms.map(({ form }) => ({ name: form.name, title: form.title, entity: byId.get(form.entity_id)!, definition: form.definition, ratePerMinute: form.rate_per_minute })),
      key: this.keyName
    };
    const signature = await s.kms.hmac(this.keyName, canonicalJson(body));
    await s.audit.append({ tenantId: app.tenant_id, action: 'app.exported', kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target: { app: app.id, name: app.name }, label: app.label, detail: { entities: body.entities.length, forms: body.forms.length }, traceId: actor.traceId ?? null });
    return { ...body, signature };
  }

  private async refuse(actor: Actor & { principal: Principal }, reason: string, detail: Record<string, unknown> = {}): Promise<never> {
    await this.s().audit.append({ tenantId: actor.principal.tenantId, action: 'app.import.refused', kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target: {}, detail: { reason, ...detail }, traceId: actor.traceId ?? null });
    throw new HttpProblem(422, 'Bundle refused', reason);
  }

  /** Verifies a bundle and creates the app it describes (optionally under another name, in the current workspace). */
  async import(actor: Actor & { principal: Principal }, raw: unknown, o: { name?: string; workspaceId?: string | null }): Promise<AppRow> {
    // The signature is checked over exactly what arrived, before anything in the bundle is interpreted.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return this.refuse(actor, `The bundle is not an ${BUNDLE_FORMAT} bundle.`);
    const { signature, ...body } = raw as Record<string, unknown>;
    if (typeof signature !== 'string' || typeof body.key !== 'string') return this.refuse(actor, 'The bundle is not signed.');
    if (body.key !== this.keyName) return this.refuse(actor, 'The bundle was signed with a key this server does not hold.', { key: body.key.slice(0, 100) });
    const ok = await this.s().kms.verifyHmac(this.keyName, canonicalJson(body), signature).catch(() => false);
    if (!ok) return this.refuse(actor, 'The bundle signature does not verify: it was changed after it was signed, or signed elsewhere.', { app: typeof (body.app as { name?: unknown } | undefined)?.name === 'string' ? String((body.app as { name: string }).name).slice(0, 63) : null });
    const parsed = bundleSchema.safeParse(raw);
    if (!parsed.success) return this.refuse(actor, `The bundle is not an ${BUNDLE_FORMAT} bundle: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim());
    const b = parsed.data;
    const names = new Set(b.entities.map((e) => e.name));
    if (names.size !== b.entities.length) return this.refuse(actor, 'The bundle lists an entity twice.');
    for (const f of b.forms) if (!names.has(f.entity)) return this.refuse(actor, `The form ${f.name} names an entity the bundle does not carry.`);

    const app = await this.apps.create(actor, { name: o.name ?? b.app.name, title: b.app.title, description: b.app.description, label: b.app.label, ...(o.workspaceId !== undefined ? { workspaceId: o.workspaceId } : {}) });
    try {
      // Entities that refer to others are created after them (two passes cover any order without cycles).
      const pending = [...b.entities];
      for (let pass = 0; pending.length && pass <= b.entities.length; pass++) {
        for (let i = 0; i < pending.length; ) {
          const e = pending[i]!;
          const created = new Set((await this.apps.entities(app)).map((x) => x.name));
          const needs = e.definition.fields.flatMap((f) => (f.type === 'reference' ? [f.entity] : f.type === 'lookup' && f.source === 'entity' && f.entity ? [f.entity] : [])).filter((n) => n !== e.name);
          if (needs.every((n) => created.has(n))) {
            await this.apps.createEntity(actor, app.id, e);
            pending.splice(i, 1);
          } else i++;
        }
      }
      if (pending.length) throw new HttpProblem(422, 'Bundle refused', `The entities ${pending.map((e) => e.name).join(', ')} refer to each other in a cycle.`);
      for (const f of b.forms) await this.apps.forms.create(actor, app.id, { name: f.name, title: f.title, entity: f.entity, definition: f.definition, ratePerMinute: f.ratePerMinute });
    } catch (err) {
      await this.apps.remove(actor, app.id).catch(() => undefined);
      throw err;
    }
    await this.s().audit.append({ tenantId: app.tenant_id, action: 'app.imported', kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target: { app: app.id, name: app.name }, label: app.label, detail: { from: b.app.name, exportedAt: b.exportedAt, entities: b.entities.length, forms: b.forms.length }, traceId: actor.traceId ?? null });
    return app;
  }
}
