import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffEntity, mergeDefinition } from '../src/apps/model-drafts.js';
import { entityDefinitionSchema } from '../src/apps/schema.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';
import { clients } from './sprint39c-helpers.js';

/*
 * 1.6.0, Sprint 39c, B-8301: a description of an app becomes a draft of its data model (entities, fields, relations,
 * formulas, state machines, triggers), shown as a diff and accepted in one step.
 */

const leaveModel = {
  entities: [
    { name: 'employee', title: 'Employee', definition: { fields: [{ name: 'name', type: 'string', required: true, indexed: true, maxLength: 200 }, { name: 'email', type: 'string', unique: true, indexed: true, maxLength: 200 }] } },
    {
      name: 'request',
      title: 'Leave request',
      definition: {
        fields: [
          { name: 'employee', type: 'reference', entity: 'employee', required: true },
          { name: 'from_day', type: 'date', required: true, indexed: true },
          { name: 'to_day', type: 'date', required: true },
          { name: 'days', type: 'formula', expression: 'days_between(from_day, to_day) + 1', indexed: true },
          { name: 'reason', type: 'string', multiline: true, maxLength: 2000 }
        ],
        states: { initial: 'submitted', states: [{ name: 'submitted' }, { name: 'approved' }, { name: 'rejected' }], transitions: [{ from: ['submitted'], to: 'approved', roles: ['workflow-admin'] }, { from: ['submitted'], to: 'rejected' }] }
      }
    }
  ],
  triggers: [{ entity: 'request', events: ['created'], workflow: 'notify-manager' }]
};

describe('data model drafts (B-8301)', () => {
  it('diffs a drafted entity against a saved one and merges without removing anything', () => {
    const saved = entityDefinitionSchema.parse({ fields: [{ name: 'name', type: 'string' }, { name: 'legacy', type: 'number' }] });
    const draft = entityDefinitionSchema.parse({ fields: [{ name: 'name', type: 'string', required: true }, { name: 'email', type: 'string' }], states: { initial: 'new', states: [{ name: 'new' }], transitions: [] } });
    const d = diffEntity('person', draft, saved);
    expect(d).toMatchObject({ change: 'changed', addedFields: ['email'], changedFields: ['name'], removedFields: ['legacy'], states: 'added' });
    const merged = mergeDefinition(saved, draft);
    expect(merged.fields.map((f) => f.name)).toEqual(['name', 'legacy', 'email']);
    expect(merged.fields[0]).toMatchObject({ required: true });
    expect(merged.states?.initial).toBe('new');
    expect(diffEntity('person', saved, saved).change).toBe('same');
    expect(diffEntity('person', draft, null)).toMatchObject({ change: 'new', addedFields: ['name', 'email'] });
  });

  describe('through the API', () => {
    let h: Harness;
    let wsId: string;
    let ollama: FakeOllama;
    beforeEach(async () => {
      h = await harness();
      wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'People', 'confidential')).id;
      ollama = await new FakeOllama().start();
      await seedGateway(h, ollama);
    });
    afterEach(async () => {
      await ollama.stop().catch(() => undefined);
      await h.close();
    });

    it('drafts a leave-request app with a request entity and an approval state machine, and accepts it in one step', async () => {
      const d = await clients(h, wsId).designer();
      await d.post('/api/apps', { name: 'leave', label: 'internal', workspaceId: wsId }).expect(201);
      let prompts: string[] = [];
      ollama.reply = (msgs) => {
        prompts.push(msgs.map((m) => m.content).join('\n'));
        return { content: '```json\n' + JSON.stringify(leaveModel) + '\n```' };
      };
      const out = (await d.post('/api/apps/leave/model/draft', { prompt: 'A leave request app: employees submit requests for a date range, a manager approves or rejects them', profile: 'general' }).expect(200)).body;
      expect(out.valid).toBe(true); // the trigger names a workflow that does not exist: reported on the trigger, not fatal
      expect(out.problems).toEqual([]);
      expect(out.diff.map((x: { entity: string; change: string }) => [x.entity, x.change])).toEqual([
        ['employee', 'new'],
        ['request', 'new']
      ]);
      expect(out.diff[1]).toMatchObject({ addedFields: ['employee', 'from_day', 'to_day', 'days', 'reason'], states: 'added' });
      expect(out.triggers[0]).toMatchObject({ ok: false, problem: expect.stringMatching(/no workflow named notify-manager/) });
      expect(prompts[0]).toMatch(/data model of a low-code app/);
      expect(prompts[0]).toContain('days_between');

      // accept the draft: both entities exist, the reference resolves, the state machine is on the request
      const applied = (await d.post('/api/apps/leave/model/apply', out.draft).expect(200)).body;
      expect(applied).toMatchObject({ created: ['employee', 'request'], updated: [], unchanged: [] });
      expect(applied.triggers[0]).toMatchObject({ created: false });
      const app = (await d.get('/api/apps/leave').expect(200)).body;
      const req = app.entities.find((e: { name: string }) => e.name === 'request');
      expect(req.definition.states.initial).toBe('submitted');
      expect(req.definition.fields.find((f: { name: string }) => f.name === 'days')).toMatchObject({ type: 'formula' });
      const emp = (await d.post('/api/apps/leave/entities/employee/records', { values: { name: 'Ada', email: 'ada@x.example' } }).expect(201)).body;
      const rec = (await d.post('/api/apps/leave/entities/request/records', { values: { employee: emp.id, from_day: '2026-11-02', to_day: '2026-11-04' } }).expect(201)).body;
      expect(rec).toMatchObject({ state: 'submitted', values: { days: 3 } });
      expect(await h.s.audit.list(h.tenantId, { action: 'app.model.applied' })).toHaveLength(1);

      // a second draft on the same app comes back as a diff: one changed entity, nothing removed on apply
      prompts = [];
      ollama.reply = (msgs) => {
        prompts.push(msgs.map((m) => m.content).join('\n'));
        return { content: JSON.stringify({ entities: [{ name: 'request', definition: { fields: [{ name: 'employee', type: 'reference', entity: 'employee' }, { name: 'half_day', type: 'boolean' }] } }] }) };
      };
      const again = (await d.post('/api/apps/leave/model/draft', { prompt: 'Add a half-day flag to requests', profile: 'general' }).expect(200)).body;
      expect(prompts[0]).toMatch(/already has these entities/);
      expect(again.valid).toBe(true);
      expect(again.diff).toEqual([expect.objectContaining({ entity: 'request', change: 'changed', addedFields: ['half_day'], removedFields: ['from_day', 'to_day', 'days', 'reason'] })]);
      const applied2 = (await d.post('/api/apps/leave/model/apply', again.draft).expect(200)).body;
      expect(applied2).toMatchObject({ created: [], updated: ['request'] });
      const after = (await d.get('/api/apps/leave/entities/request').expect(200)).body;
      expect(after.definition.fields.map((f: { name: string }) => f.name)).toEqual(['employee', 'from_day', 'to_day', 'days', 'reason', 'half_day']);
      expect(after.definition.states.initial).toBe('submitted');
    });

    it('reports an unusable draft with its problems and refuses to apply one', async () => {
      const d = await clients(h, wsId).designer();
      await d.post('/api/apps', { name: 'bad', label: 'internal', workspaceId: wsId }).expect(201);
      ollama.reply = () => ({ content: JSON.stringify({ entities: [{ name: 'Ticket', definition: { fields: [{ name: 'subject', type: 'string' }] } }, { name: 'note', definition: { fields: [{ name: 'ticket', type: 'reference', entity: 'nope' }, { name: 'len', type: 'formula', expression: 'process' }] } }] }) });
      const out = (await d.post('/api/apps/bad/model/draft', { prompt: 'Tickets and notes', profile: 'general' }).expect(200)).body;
      expect(out.valid).toBe(false);
      expect(out.problems.join('\n')).toMatch(/entities\.0\.name/);
      expect(out.problems.join('\n')).toMatch(/no entity nope/);
      expect(out.draft.entities.map((e: { name: string }) => e.name)).toEqual(['note']); // what parsed on its own is kept for editing
      await d.post('/api/apps/bad/model/apply', { entities: out.draft.entities }).expect(422);
      ollama.reply = () => ({ content: 'Sorry, no.' });
      await d.post('/api/apps/bad/model/draft', { prompt: 'Anything', profile: 'general' }).expect(422);
      // a member without apps:design cannot draft
      const m = await clients(h, wsId).member('mo');
      await m.post('/api/apps/bad/model/draft', { prompt: 'Anything at all', profile: 'general' }).expect(403);
    });
  });
});
