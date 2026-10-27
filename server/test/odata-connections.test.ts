/*
 * 1.9.0: OData v4 API connections against an in-process fake service. `$metadata` read with the strict parser (a
 * DOCTYPE refused, actions listed but never offered), entity sets and singletons, `$select`/`$filter`/`$orderby`/
 * `$expand`/`$search` checked at save, parameters written as literals by the type of the property they meet (strings
 * quoted with quotes doubled, numbers, dates, GUIDs), so a value cannot change the filter; `$top`/`$skip` paging and
 * server-driven paging by `@odata.nextLink` (one outside the base URL refused), and an OData error answer.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filterProblems, odataLiteral, parseMetadata, renderFilter, renderSearch, type ODataSet } from '../src/connections/odata.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

const METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop" Alias="S" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32" Nullable="false"/></EntityType>
      <EntityType Name="Product" BaseType="S.Base">
        <Property Name="Name" Type="Edm.String"/>
        <Property Name="Price" Type="Edm.Decimal"/>
        <Property Name="Released" Type="Edm.DateTimeOffset"/>
        <Property Name="Sku" Type="Edm.Guid"/>
        <Property Name="InStock" Type="Edm.Boolean"/>
        <NavigationProperty Name="Category" Type="Shop.Category"/>
        <NavigationProperty Name="Reviews" Type="Collection(Shop.Review)"/>
      </EntityType>
      <EntityType Name="Category"><Key><PropertyRef Name="Code"/></Key><Property Name="Code" Type="Edm.String" Nullable="false"/><Property Name="Title" Type="Edm.String"/></EntityType>
      <EntityType Name="Review"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32"/><Property Name="Text" Type="Edm.String"/></EntityType>
      <EntityType Name="Settings"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32"/><Property Name="Currency" Type="Edm.String"/></EntityType>
      <Action Name="Discontinue" IsBound="true"><Parameter Name="p" Type="Shop.Product"/></Action>
      <Function Name="TopSellers"><ReturnType Type="Collection(Shop.Product)"/></Function>
      <EntityContainer Name="Container">
        <EntitySet Name="Products" EntityType="Shop.Product"/>
        <EntitySet Name="Categories" EntityType="S.Category"/>
        <Singleton Name="Me" Type="Shop.Settings"/>
        <ActionImport Name="ResetCatalog" Action="Shop.ResetCatalog"/>
        <FunctionImport Name="GetTopSellers" Function="Shop.TopSellers"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const PRODUCTS = Array.from({ length: 12 }, (_, i) => ({ Id: i + 1, Name: `Product ${i + 1}`, Price: 10 + i, Released: `2026-0${(i % 9) + 1}-01T00:00:00Z`, Sku: '0f8fad5b-d9cb-469f-a165-70867728950e', InStock: i % 2 === 0 }));

class FakeOData {
  server!: Server;
  url = '';
  seen: { path: string; query: Record<string, string>; accept: string | undefined; auth: string | undefined }[] = [];
  metadata = METADATA;

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json;odata.metadata=minimal', 'odata-version': '4.0' });
    res.end(JSON.stringify(body));
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? '/', this.url);
    const q = Object.fromEntries(u.searchParams);
    this.seen.push({ path: u.pathname, query: q, accept: req.headers.accept, auth: req.headers.authorization });
    const root = '/odata/v4';
    switch (u.pathname) {
      case `${root}/$metadata`:
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(this.metadata);
      case `${root}/Products`: {
        if (q.$filter?.includes('boom')) return this.send(res, 400, { error: { code: 'BadFilter', message: 'The filter is not supported here.' } });
        const top = Number(q.$top ?? 5);
        const skip = Number(q.$skip ?? 0);
        const page = PRODUCTS.slice(skip, skip + top);
        // Server-driven paging: a nextLink while items remain (with $top absent the page size is the server's 5).
        const next = skip + top < PRODUCTS.length ? `${this.url}${root}/Products?$skiptoken=${skip + top}` : null;
        if (q.$skiptoken) {
          const from = Number(q.$skiptoken);
          const p2 = PRODUCTS.slice(from, from + 5);
          return this.send(res, 200, { '@odata.context': '$metadata#Products', value: p2, ...(from + 5 < PRODUCTS.length ? { '@odata.nextLink': `${this.url}${root}/Products?$skiptoken=${from + 5}` } : {}) });
        }
        return this.send(res, 200, { '@odata.context': '$metadata#Products', ...(q.$count ? { '@odata.count': PRODUCTS.length } : {}), value: page, ...(next && !q.$top ? { '@odata.nextLink': next } : {}) });
      }
      case `${root}/Categories`:
        return this.send(res, 200, { value: [{ Code: 'a', Title: 'A' }], '@odata.nextLink': 'http://127.0.0.1:9/elsewhere/Categories?$skiptoken=1' });
      case `${root}/Me`:
        return this.send(res, 200, { '@odata.context': '$metadata#Me', Id: 1, Currency: 'EUR' });
      default:
        return this.send(res, 404, { error: { code: 'NotFound', message: 'No such resource.' } });
    }
  }
}

describe('OData helpers', () => {
  const meta = parseMetadata(METADATA);
  const products = meta.sets.find((s) => s.name === 'Products') as ODataSet;

  it('reads entity sets, singletons, inherited keys and navigation; lists actions and functions without offering them', () => {
    expect(meta.sets.map((s) => `${s.kind}:${s.name}`)).toEqual(['set:Products', 'set:Categories', 'singleton:Me']);
    expect(products.properties.map((p) => p.name)).toEqual(['Id', 'Name', 'Price', 'Released', 'Sku', 'InStock']);
    expect(products.properties[0]).toEqual({ name: 'Id', type: 'Edm.Int32', nullable: false, key: true });
    expect(products.navigation).toEqual([{ name: 'Category', type: 'Shop.Category', collection: false }, { name: 'Reviews', type: 'Shop.Review', collection: true }]);
    expect(meta.actions).toEqual(['Discontinue', 'ResetCatalog']);
    expect(meta.functions).toEqual(['TopSellers', 'GetTopSellers']);
    expect(meta.notes.join(' ')).toMatch(/Actions are never called.*Functions are not offered/);
    expect(() => parseMetadata(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${METADATA.replace(/^<\?xml[^>]*>/, '')}`)).toThrow(/DOCTYPE/);
    expect(() => parseMetadata('<x/>')).toThrow(/not OData v4 metadata/);
  });

  it('checks filters and writes parameters as literals of the property they meet', () => {
    const params = new Set(['name', 'min', 'since', 'sku', 'ids', 'stock']);
    expect(filterProblems("contains(Name, {name}) and Price ge {min} and Released gt {since}", products, params)).toEqual([]);
    expect(filterProblems('Secret eq 1', products, params)[0]).toMatch(/Secret is not a property of Products/);
    expect(filterProblems('Category/Title eq {name}', products, params)).toEqual([]);
    expect(filterProblems('Name eq {nope}', products, params)[0]).toMatch(/\{nope\} is not a parameter/);
    expect(filterProblems('Name eq "x"', products, params)[0]).toMatch(/not part of a property/);
    expect(filterProblems('(Name eq {name}', products, params)[0]).toMatch(/without its \)/);
    const types = { name: 'string', min: 'number', since: 'date', sku: 'string', ids: 'list', stock: 'boolean' };
    const values = { name: "O'Brien' or 1 eq 1 or Name eq '", min: 12, since: '2026-03-01', sku: '0F8FAD5B-D9CB-469F-A165-70867728950E', ids: [1, 2, 3], stock: true };
    expect(renderFilter("contains(Name, {name}) and Price ge {min} and Released gt {since} and Sku eq {sku} and Id in ({ids}) and InStock eq {stock}", products, values, types)).toBe(
      "contains(Name,'O''Brien'' or 1 eq 1 or Name eq ''') and Price ge 12 and Released gt 2026-03-01T00:00:00.000Z and Sku eq 0f8fad5b-d9cb-469f-a165-70867728950e and Id in (1,2,3) and InStock eq true"
    );
    // A value that is not of the property's type is refused, not passed through.
    expect(() => renderFilter('Price ge {min}', products, { min: '12 or 1 eq 1' }, { min: 'string' })).toThrow(/not a number/);
    expect(() => renderFilter('Sku eq {sku}', products, { sku: "x' or 1 eq 1" }, { sku: 'string' })).toThrow(/not a GUID/);
    expect(odataLiteral("it's", null)).toBe("'it''s'");
    expect(renderSearch('{q} AND blue', { q: 'say "hi" \\ there' })).toBe('"say \\"hi\\" \\\\ there" AND blue');
  });
});

describe('OData connections', () => {
  let h: Harness;
  let api: FakeOData;

  beforeEach(async () => {
    api = await new FakeOData().start();
    h = await harness({ OLLAMA_POLL_MS: '600000', SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    await h.s.integrations.set(h.tenantId, { allowedHosts: ['127.0.0.1'] }, 'test');
  });
  afterEach(async () => {
    await h.close();
    await api.stop();
  });

  async function admin() {
    await localUser(h, 'odataadmin', ['connection-admin', 'tenant-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, 'odataadmin');
    const send = (m: 'post' | 'patch', p: string, b: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b);
    return { post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), get: (p: string) => c.agent.get(p) };
  }

  it('reads $metadata at registration, checks endpoints against it, escapes parameters and pages', async () => {
    const a = await admin();
    const conn = (await a.post('/api/admin/rest-connections', { name: 'shop', protocol: 'odata', baseUrl: `${api.url}/odata/v4`, label: 'internal', auth: { kind: 'bearer', secret: 'tok-odata' } }).expect(201)).body;
    expect(conn.protocol).toBe('odata');
    expect(conn.metadataUrl).toBe(`${api.url}/odata/v4/$metadata`);
    expect(conn.odata.sets.map((s: { name: string }) => s.name)).toEqual(['Products', 'Categories', 'Me']);
    expect(api.seen[0]).toMatchObject({ path: '/odata/v4/$metadata', auth: 'Bearer tok-odata' });
    expect((await a.post(`/api/admin/rest-connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true, health: 'healthy' });

    const ep = (name: string, definition: object) => a.post(`/api/admin/rest-connections/${conn.id}/endpoints`, { name, definition });
    // Checked at save against the metadata.
    expect((await ep('bad', { odata: { entitySet: 'Orders' } }).expect(422)).body.detail).toMatch(/Orders is not an entity set/);
    expect((await ep('bad', { odata: { entitySet: 'Products', select: ['Cost'] } }).expect(422)).body.detail).toMatch(/Cost is not a property/);
    expect((await ep('bad', { odata: { entitySet: 'Products', expand: ['Name'] } }).expect(422)).body.detail).toMatch(/Name is not a navigation property/);
    expect((await ep('bad', { odata: { entitySet: 'Products', filter: 'Cost gt 1' } }).expect(422)).body.detail).toMatch(/Cost is not a property/);
    expect((await ep('bad', { odata: { entitySet: 'Products', orderby: 'Price sideways' } }).expect(422)).body.detail).toMatch(/not a property followed by asc or desc/);
    expect((await ep('bad', { odata: { entitySet: 'Products' }, paging: { kind: 'page' } }).expect(422)).body.detail).toMatch(/\$top and \$skip/);
    // $-names are not query parameters: refused by the definition's shape before the protocol check.
    await ep('bad', { odata: { entitySet: 'Products' }, query: { $filter: 'x' } }).expect(400);
    expect((await ep('bad', { graphql: { query: '{ a }' } }).expect(422)).body.detail).toMatch(/OData connection/);
    expect((await ep('bad', { odata: { entitySet: 'Me', filter: 'Id eq 1' } }).expect(422)).body.detail).toMatch(/singleton/);

    await ep('cheap', {
      params: [{ name: 'name', type: 'string', required: true }, { name: 'max', type: 'number' }, { name: 'since', type: 'date' }],
      odata: { entitySet: 'Products', select: ['Id', 'Name', 'Price'], filter: 'contains(Name, {name}) and Price le {max} and Released ge {since}', orderby: 'Price desc', expand: ['Category'], count: true },
      paging: { kind: 'offset', offsetParam: '$skip', limitParam: '$top', size: 4 }
    }).expect(201);
    const read = (name: string, body: object = {}) => a.post(`/api/rest-connections/${conn.id}/endpoints/${name}/read`, body);
    const r = (await read('cheap', { params: { name: "x' or true or Name eq '", max: 100, since: '2026-01-01' } }).expect(200)).body;
    expect(r.rows).toHaveLength(12);
    // Offset paging asks once more to see that no items are left, as for REST.
    expect(r.pages).toBe(4);
    const first = api.seen.filter((x) => x.path === '/odata/v4/Products')[0]!;
    expect(first.accept).toBe('application/json;odata.metadata=minimal');
    expect(first.query).toMatchObject({ $select: 'Id,Name,Price', $expand: 'Category', $orderby: 'Price desc', $count: 'true', $top: '4', $skip: '0', $filter: "contains(Name,'x'' or true or Name eq ''') and Price le 100 and Released ge 2026-01-01T00:00:00.000Z" });
    // A value of the wrong type for its property is a 400, nothing sent.
    const before = api.seen.length;
    expect((await read('cheap', { params: { name: 'a', max: 'cheap' } }).expect(400)).body.detail).toMatch(/max should be a number/);
    expect(api.seen.length).toBe(before);

    // Server-driven paging: @odata.nextLink under the base is followed; one outside it is refused.
    await ep('all', { odata: { entitySet: 'Products' }, paging: { kind: 'link', maxPages: 10 } }).expect(201);
    const all = (await read('all').expect(200)).body;
    expect(all.rows).toHaveLength(12);
    expect(all.pages).toBe(3);
    await ep('cats', { odata: { entitySet: 'Categories' }, paging: { kind: 'link' } }).expect(201);
    expect((await read('cats').expect(502)).body.detail).toMatch(/outside/);
    // A singleton is the answer itself.
    await ep('me', { odata: { entitySet: 'Me', select: ['Currency'] } }).expect(201);
    expect((await read('me').expect(200)).body.rows).toEqual([{ Id: 1, Currency: 'EUR' }]);
    // An OData error answer is a 502 with its message.
    await ep('boom', { odata: { entitySet: 'Products', filter: "Name eq 'boom'" } }).expect(201);
    const e = (await read('boom').expect(502)).body;
    expect(e.title).toBe('OData error');
    expect(e.detail).toMatch(/BadFilter.*not supported/);

    // Refresh: the entity sets an endpoint uses that are gone are listed.
    api.metadata = METADATA.replace('<EntitySet Name="Categories" EntityType="S.Category"/>', '');
    const ref = (await a.post(`/api/admin/rest-connections/${conn.id}/odata/metadata`).expect(200)).body;
    expect(ref.missing).toEqual(['cats']);
    const audits = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereLike('action', 'connection.rest.%').select('action', 'detail')) as { action: string; detail: string }[];
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(['connection.rest.registered', 'connection.rest.metadata.refreshed', 'connection.rest.read', 'connection.rest.read.failed']));
    expect(audits.some((x) => /tok-odata/.test(x.detail))).toBe(false);
  });

  it('refuses a service whose $metadata has a DOCTYPE, and keeps nothing', async () => {
    const a = await admin();
    api.metadata = `<!DOCTYPE x [<!ENTITY e "boom">]>\n${METADATA.replace(/^<\?xml[^>]*>/, '')}`;
    const r = (await a.post('/api/admin/rest-connections', { name: 'evil', protocol: 'odata', baseUrl: `${api.url}/odata/v4`, label: 'internal' }).expect(422)).body;
    expect(r.detail).toMatch(/DOCTYPE/);
    expect(await h.s.db('rest_connections').where({ tenant_id: h.tenantId, name: 'evil' }).first()).toBeUndefined();
  });
});
