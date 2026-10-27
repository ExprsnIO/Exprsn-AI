/*
 * 1.9.0: SQL Server and Azure SQL connections without a server: the T-SQL classifier (reads, and every family it
 * refuses), objects resolved against the allow-list in SQL Server's naming, saved-query parameters bound as @pN, the
 * rule a reroute must keep to, and the Entra token request against an in-process token endpoint.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyTsql } from '../src/connections/classify-tsql.js';
import { allowedQualified } from '../src/connections/dialects.js';
import { entraToken, quoteTsqlIdent, reroutingAllowed } from '../src/connections/mssql.js';
import { paramsSchema } from '../src/connections/params.js';
import { renderSql, sqlPieces } from '../src/connections/saved-queries.js';
import { ConnectionService, type ConnectionRow } from '../src/connections/service.js';
import { parseAllowList } from '../src/mcp/hosts.js';

const row = (over: Partial<ConnectionRow> = {}): ConnectionRow => ({
  id: 'c1',
  tenant_id: 't1',
  name: 'sales',
  engine: 'mssql',
  endpoint: 'sql.internal:1433',
  database: 'Sales',
  zone: 'data',
  label: 'internal',
  ops: 'read',
  row_limit: 100,
  timeout_s: 5,
  credential: null,
  account: 'reader',
  credential_source: 'static',
  bao_role: null,
  vault_owner: null,
  tls: true,
  options: { schema: 'dbo' },
  allow_list: ['dbo.Orders', 'Reporting.Customers'],
  pii_columns: [],
  schema: null,
  schema_at: null,
  health: 'unknown',
  health_detail: null,
  checked_at: null,
  version: 1,
  created_by: null,
  created_at: 0,
  updated_at: 0,
  ...over
});

const service = new ConnectionService(null as never, null as never, null as never, null as never, {});

describe('T-SQL classifier', () => {
  it('reads plain, bracketed, TOP, CTE, APPLY-free and FOR JSON selects', () => {
    expect(classifyTsql('SELECT TOP (10) [Id], N\'x\' AS [Name] FROM [dbo].[Orders] WITH (NOLOCK) ORDER BY [Id] DESC')).toMatchObject({ kind: 'read', verb: 'SELECT', objects: ['dbo.Orders'] });
    expect(classifyTsql('WITH recent AS (SELECT * FROM dbo.orders WHERE placed > DATEADD(day, -7, SYSUTCDATETIME())) SELECT COUNT(*) FROM recent')).toMatchObject({ kind: 'read', objects: ['dbo.orders'] });
    expect(classifyTsql("SELECT o.id FROM Sales.dbo.Orders o JOIN Sales..Customers c ON c.id = o.customer_id WHERE c.note <> 'a''b; DELETE' FOR JSON PATH")).toMatchObject({ kind: 'read', objects: ['sales.dbo.orders', 'sales..customers'] });
    expect(classifyTsql('SELECT 1 FROM dbo.a UNION ALL SELECT 2 FROM dbo.b;')).toMatchObject({ kind: 'read', objects: ['dbo.a', 'dbo.b'] });
    expect(classifyTsql('/* a /* nested */ comment */ SELECT x FROM t -- trailing\n')).toMatchObject({ kind: 'read', objects: ['t'] });
    expect(classifyTsql('SELECT geography::Point(1, 2, 4326).STAsText() AS p FROM dbo.places')).toMatchObject({ kind: 'read', objects: ['dbo.places'] });
  });

  it('checks what APPLY applies as a table reference', () => {
    expect(classifyTsql('SELECT * FROM dbo.Orders o CROSS APPLY (SELECT TOP 1 * FROM dbo.Lines l WHERE l.order_id = o.id) x')).toMatchObject({ kind: 'read', objects: ['dbo.orders', 'dbo.lines'] });
    expect(classifyTsql('SELECT * FROM dbo.Orders o OUTER APPLY dbo.lines_of(o.id) x').kind).toBe('unparsed');
  });

  it('refuses a second statement, with or without a semicolon, and GO', () => {
    expect(classifyTsql('SELECT 1 FROM a; SELECT 2 FROM b').kind).toBe('multiple');
    expect(classifyTsql('SELECT 1 FROM a SELECT 2 FROM b').kind).toBe('multiple');
    expect(classifyTsql('SELECT 1 FROM a\nGO\nSELECT 2 FROM b').kind).toBe('multiple');
    expect(classifyTsql('SELECT * FROM a DECLARE @x int').kind).toBe('multiple');
  });

  it('refuses writes, EXEC and SELECT INTO', () => {
    for (const q of ['INSERT INTO dbo.t VALUES (1)', 'UPDATE dbo.t SET a = 1', 'DELETE dbo.t', 'MERGE dbo.t AS x USING dbo.s AS y ON 1 = 1 WHEN MATCHED THEN DELETE;', "BULK INSERT dbo.t FROM 'c:\\x.csv'", 'EXEC dbo.purge', "EXECUTE sp_executesql N'DELETE dbo.t'", 'SELECT * INTO dbo.copy FROM dbo.t', 'SELECT * FROM dbo.t; DELETE dbo.t', 'WITH x AS (SELECT 1 AS a) DELETE FROM dbo.t']) {
      const c = classifyTsql(q);
      expect(['write', 'denied'], q).toContain(c.kind);
    }
    expect(classifyTsql('SELECT * INTO #tmp FROM dbo.t')).toMatchObject({ kind: 'write', verb: 'SELECT INTO' });
  });

  it('refuses DDL, settings, permissions, transactions and server verbs', () => {
    for (const q of ['CREATE TABLE x (a int)', 'DROP TABLE dbo.t', 'ALTER TABLE dbo.t ADD b int', 'TRUNCATE TABLE dbo.t', 'GRANT SELECT ON dbo.t TO bob', 'DENY SELECT ON dbo.t TO bob', 'SET NOCOUNT ON', 'USE master', 'DBCC CHECKDB', "BACKUP DATABASE x TO DISK = 'x'", 'KILL 51', 'SHUTDOWN', 'RECONFIGURE', "WAITFOR DELAY '00:00:10'", 'DECLARE @a int', 'BEGIN TRAN', 'COMMIT', 'ROLLBACK']) {
      const c = classifyTsql(q);
      expect(['ddl', 'write'], q).toContain(c.kind);
    }
  });

  it('refuses rowset providers, extended and system procedures and file-reading functions', () => {
    expect(classifyTsql("SELECT * FROM OPENROWSET(BULK 'c:\\secret.txt', SINGLE_CLOB) AS x")).toMatchObject({ kind: 'denied', denied: 'openrowset()' });
    expect(classifyTsql("SELECT * FROM OPENQUERY(linked, 'SELECT 1')").kind).toBe('denied');
    expect(classifyTsql("SELECT * FROM OPENDATASOURCE('SQLNCLI', 'x').db.dbo.t").kind).toBe('denied');
    expect(classifyTsql('SELECT * FROM sys.fn_get_audit_file(\'x\', default, default)').kind).toBe('denied');
    expect(classifyTsql('SELECT * FROM sys.fn_trace_gettable(\'x\', 1)').kind).toBe('denied');
    expect(classifyTsql('SELECT xp_cmdshell').kind).toBe('denied');
    expect(classifyTsql('SELECT * FROM t WHERE x = sp_helptext').kind).toBe('denied');
  });

  it('refuses locking table hints', () => {
    expect(classifyTsql('SELECT * FROM dbo.t WITH (UPDLOCK, ROWLOCK)')).toMatchObject({ kind: 'write', verb: 'WITH (UPDLOCK)' });
    expect(classifyTsql('SELECT * FROM dbo.t WITH (XLOCK)').kind).toBe('write');
    expect(classifyTsql('SELECT * FROM dbo.t WITH (HOLDLOCK)').kind).toBe('write');
    expect(classifyTsql('SELECT * FROM dbo.t WITH (TABLOCKX)').kind).toBe('write');
  });

  it('keeps strings, brackets and comments from hiding or faking anything', () => {
    expect(classifyTsql("SELECT 'DROP TABLE x; EXEC xp_cmdshell' AS s FROM dbo.Orders")).toMatchObject({ kind: 'read', objects: ['dbo.orders'] });
    expect(classifyTsql('SELECT [delete], [exec] FROM [dbo].[Orders]')).toMatchObject({ kind: 'read', objects: ['dbo.Orders'] });
    expect(classifyTsql("SELECT N'unterminated FROM t").kind).toBe('unparsed');
    expect(classifyTsql('SELECT [unterminated FROM t').kind).toBe('unparsed');
    expect(classifyTsql('/* open SELECT 1').kind).toBe('unparsed');
  });
});

describe('SQL Server objects against the allow-list', () => {
  it('resolves unqualified, three-part and db..table names to the connection', () => {
    const c = row();
    expect(service.classify(c, { query: 'SELECT * FROM Orders' })).toMatchObject({ kind: 'read', objects: ['orders'] });
    expect(service.classify(c, { query: 'SELECT * FROM [Sales].[dbo].[Orders]' }).kind).toBe('read');
    expect(service.classify(c, { query: 'SELECT * FROM Sales..Orders' }).kind).toBe('read');
    expect(service.classify(c, { query: 'SELECT * FROM reporting.customers' }).kind).toBe('read');
    expect(service.classify(c, { query: 'SELECT * FROM dbo.Payroll' })).toMatchObject({ kind: 'denied', denied: 'dbo.payroll' });
    expect(service.classify(c, { query: 'SELECT * FROM master.dbo.Orders' }).kind).toBe('denied');
    expect(service.classify(c, { query: 'SELECT * FROM master..sysxlogins' }).kind).toBe('denied');
    expect(service.classify(c, { query: 'SELECT * FROM srv.Sales.dbo.Orders' }).kind).toBe('denied');
    expect(allowedQualified('Orders', ['dbo.orders'], { engine: 'azure-sql', database: 'x', account: null, options: {} })).toBe(true);
    expect(allowedQualified('Orders', ['dbo.orders'], { engine: 'azure-sql', database: 'x', account: null, options: { schema: 'app' } })).toBe(false);
  });
});

describe('saved queries in T-SQL', () => {
  it('binds @pN once per parameter, a list once per item, and skips [idents] and N strings', () => {
    const defs = paramsSchema.parse([
      { name: 'tier', type: 'string' },
      { name: 'ids', type: 'list' }
    ]);
    const names = new Set(['tier', 'ids']);
    const sql = "SELECT [a:tier], N':ids' AS x FROM dbo.customers WHERE tier = :tier OR alt = :tier AND id IN (:ids) -- :nothing";
    const out = renderSql(sqlPieces(sql, 'tsql', names).pieces, 'tsql', defs, { tier: 'gold', ids: [1, 2] });
    expect(out).toEqual({ text: "SELECT [a:tier], N':ids' AS x FROM dbo.customers WHERE tier = @p1 OR alt = @p1 AND id IN (@p2, @p3) -- :nothing", params: ['gold', 1, 2] });
    expect(quoteTsqlIdent('dbo.we]ird')).toBe('[dbo].[we]]ird]');
  });
});

describe('Azure rerouting', () => {
  it('stays within the endpoint\'s parent domain', () => {
    expect(reroutingAllowed('sales.database.windows.net', 'abc.tr5.westeurope1-a.worker.database.windows.net')).toBe(true);
    expect(reroutingAllowed('sales.database.windows.net', 'evil.example.com')).toBe(false);
    expect(reroutingAllowed('sales.database.windows.net', 'database.windows.net.evil.com')).toBe(false);
    expect(reroutingAllowed('sales.database.windows.net', '10.0.0.5')).toBe(false);
    expect(reroutingAllowed('10.0.0.4', 'x.database.windows.net')).toBe(false);
    expect(reroutingAllowed('sql.corp', 'x.corp')).toBe(false);
  });
});

describe('Entra token for Azure SQL', () => {
  let server: Server;
  let url = '';
  const seen: { path: string; body: URLSearchParams }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        const f = new URLSearchParams(body);
        seen.push({ path: req.url ?? '', body: f });
        res.setHeader('content-type', 'application/json');
        if (f.get('client_secret') !== 'right-secret') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\nTrace ID: x' }));
          return;
        }
        res.end(JSON.stringify({ access_token: `token-${seen.length}`, expires_in: 3600, token_type: 'Bearer' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('asks for the database scope with client credentials and caches the token', async () => {
    const o = { tenantId: 'contoso.onmicrosoft.com', clientId: 'app-1', secret: 'right-secret', allow: parseAllowList(''), timeoutMs: 3000, authority: url };
    expect(await entraToken(o)).toBe('token-1');
    expect(await entraToken(o)).toBe('token-1');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/contoso.onmicrosoft.com/oauth2/v2.0/token');
    expect(Object.fromEntries(seen[0]!.body)).toEqual({ grant_type: 'client_credentials', client_id: 'app-1', client_secret: 'right-secret', scope: 'https://database.windows.net/.default' });
  });

  it('reports a refusal without the secret', async () => {
    const err = await entraToken({ tenantId: 't', clientId: 'app-2', secret: 'wrong-secret', allow: parseAllowList(''), timeoutMs: 3000, authority: url }).catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/401, invalid_client\): AADSTS7000215/);
    expect(String((err as Error).message)).not.toMatch(/wrong-secret|Trace ID/);
  });

  it('refuses a public authority address that is not allowed', async () => {
    await expect(entraToken({ tenantId: 't', clientId: 'a', secret: 's', allow: parseAllowList(''), timeoutMs: 1000, authority: 'https://8.8.8.8' })).rejects.toThrow(/public address/);
  });
});
