import { createHash } from 'node:crypto';
import { clears, highest, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { conflict, forbidden, HttpProblem } from '../http/problem.js';
import type { AddSourceInput, ExternalSourceConfig, ExternalSourceProvider, SourceRow } from '../knowledge/service.js';
import type { SourceItem } from '../knowledge/sources.js';
import type { Services } from '../services.js';
import { bindParams } from './params.js';
import type { ReadResult } from './saved-queries.js';

/*
 * 1.8.0 (B-125, B-126): saved queries and REST endpoints as knowledge sources. A row becomes a document, as a
 * database source's rows do ("# <source> <id>" and one "column: value" line each), keyed by the id field (or its place
 * in the listing), versioned by its content hash, so an unchanged row is not indexed again and a row gone from the
 * listing is removed. The curator who adds the source needs `connections:query` and clearance for the query or
 * connection; each sync then reads through the same governed path (allow-list, masking, `db-query`; for REST the host
 * rules and `untrusted-content`) as a service run held to the source's label floor. Retrieved chunks pass the
 * `untrusted-content` checkpoint again before a model reads them.
 */

const MAX_ROWS = 5000;
const PAGE = 500;

function rowDocument(name: string, id: string, title: string | null, row: Record<string, unknown>): SourceItem {
  const body = `# ${title ?? `${name} ${id}`}\n\n` + Object.entries(row).map(([k, v]) => `${k}: ${v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n');
  const data = Buffer.from(body, 'utf8');
  return { key: `${name}#${id}`, name: (title ?? `${name} #${id}`).slice(0, 200), version: createHash('sha256').update(data).digest('hex'), size: data.length, read: async () => data };
}

export class ExternalKnowledgeSources {
  constructor(private readonly s: () => Services) {}

  private need(p: Principal): void {
    const d = authorize(p, 'connections:query', { tenantId: p.tenantId });
    if (!d.allow) throw forbidden(`A saved query or REST endpoint as a source needs connections:query: ${d.reason}.`, { step: 'role', action: 'connections:query' });
  }

  provider(kind: 'saved-query' | 'rest'): ExternalSourceProvider {
    return {
      check: (p, input) => (kind === 'saved-query' ? this.checkQuery(p, input) : this.checkRest(p, input)),
      items: (src, signal) => this.items(kind, src, signal)
    };
  }

  private async checkQuery(p: Principal, input: AddSourceInput): Promise<{ location: string; external: ExternalSourceConfig; floor: Label }> {
    this.need(p);
    if (!input.queryId) throw new HttpProblem(400, 'Invalid request', 'Name the saved query the source reads (queryId).');
    const q = await this.s().savedQueries.get(p.tenantId, input.queryId).catch(() => null);
    if (!q || !clears(p.clearance, q.label)) throw new HttpProblem(404, 'Not found', 'Saved query not found.');
    if (q.write) throw conflict(`${q.name} is a write query; only read queries are sources.`);
    if (q.published_version == null) throw conflict(`${q.name} has no published version yet.`);
    const c = await this.s().connections.get(p.tenantId, q.connection_id);
    const v = await this.s().savedQueries.version(q, q.published_version);
    bindParams(v.definition.params, input.params ?? {});
    return { location: `query: ${q.name}`, external: { ref: q.id, params: input.params ?? {}, idField: input.idField ?? null, titleField: input.titleField ?? null }, floor: highest(q.label, c.label) };
  }

  private async checkRest(p: Principal, input: AddSourceInput): Promise<{ location: string; external: ExternalSourceConfig; floor: Label }> {
    this.need(p);
    if (!input.connectionId || !input.resource) throw new HttpProblem(400, 'Invalid request', 'Name the REST connection (connectionId) and its endpoint (resource).');
    const c = await this.s().restConnections.get(p.tenantId, input.connectionId).catch(() => null);
    if (!c || !clears(p.clearance, c.label)) throw new HttpProblem(404, 'Not found', 'REST connection not found.');
    const e = await this.s().restConnections.endpoint(c, input.resource);
    bindParams(e.definition.params, input.params ?? {});
    return { location: `rest: ${c.name}.${e.name}`, external: { connectionId: c.id, endpoint: e.name, params: input.params ?? {}, idField: input.idField ?? null, titleField: input.titleField ?? null }, floor: c.label };
  }

  /** Every row, page by page up to MAX_ROWS, as documents. */
  private async items(kind: 'saved-query' | 'rest', src: SourceRow, signal: AbortSignal): Promise<SourceItem[]> {
    const ext = src.config.external ?? {};
    const via = `knowledge-source:${src.id}`;
    const rows: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    let name = '';
    do {
      if (signal.aborted) throw signal.reason as Error;
      let r: ReadResult;
      if (kind === 'saved-query') {
        r = await this.s().savedQueries.runAsService(src.tenant_id, ext.ref ?? '', ext.params ?? {}, { ceiling: src.label_floor, via, limit: PAGE, cursor });
        name ||= (await this.s().savedQueries.get(src.tenant_id, ext.ref ?? '')).name;
      } else {
        const c = await this.s().restConnections.get(src.tenant_id, ext.connectionId ?? '');
        const e = await this.s().restConnections.endpoint(c, ext.endpoint ?? '');
        r = await this.s().restConnections.fetchRows({ tenantId: src.tenant_id, principal: null, ceiling: src.label_floor, via }, c, e, ext.params ?? {}, { limit: PAGE, cursor, signal });
        name ||= `${c.name}.${e.name}`;
      }
      rows.push(...r.rows);
      cursor = r.nextCursor ?? null;
    } while (cursor && rows.length < MAX_ROWS);
    return rows.slice(0, MAX_ROWS).map((row, i) => {
      const id = ext.idField && row[ext.idField] != null ? String(row[ext.idField]) : String(i + 1);
      const title = ext.titleField && row[ext.titleField] != null ? String(row[ext.titleField]) : null;
      return rowDocument(name, id, title, row);
    });
  }
}
