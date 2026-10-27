/*
 * 1.9.99-final, Sprint 59 (B-10304, B-10306): the AWS data services `FakeAws` also answers (same port; the SigV4
 * scope says the service). Never the real AWS.
 *
 * - DynamoDB (JSON 1.0, `x-amz-target: DynamoDB_20120810.<op>`): ListTables, DescribeTable, Query (a key condition
 *   `<pk> = :v`, optionally `AND <sk> = :w`, with ExpressionAttributeNames, Limit and ExclusiveStartKey), Scan (Limit,
 *   for the schema sample), ExecuteStatement (`SELECT * FROM "<table>" WHERE <pk> = ?` or `= '<literal>'`, Limit and
 *   NextToken). Anything else is answered `UnknownOperationException` and recorded, so a test can show that no write
 *   ever reached it (`ops`).
 * - RDS (Query API): DescribeDBInstances and DescribeDBClusters from `dbInstances` and `dbClusters` (DocumentDB
 *   clusters are clusters with engine `docdb`). Other RDS actions fall through to `FakeAws`'s own answer.
 */
import type { RecordedRequest, Reply } from './fake-cloud-base.js';
import { xmlEsc } from './fake-cloud-base.js';

type Attr = Record<string, unknown>;
export interface FakeTable {
  name: string;
  pk: string;
  sk?: string;
  pkType?: 'S' | 'N';
  items: Record<string, Attr>[];
  gsi?: { name: string; pk: string }[];
}

export interface FakeDbInstance {
  id: string;
  engine: string;
  host: string;
  port: number;
  dbName?: string;
  masterUser?: string;
  publiclyAccessible?: boolean;
  iamAuth?: boolean;
  cluster?: string;
  tags?: Record<string, string>;
  status?: string;
}

export interface FakeDbCluster {
  id: string;
  engine: string;
  writer: string;
  reader?: string;
  port: number;
  dbName?: string;
  masterUser?: string;
  iamAuth?: boolean;
  tags?: Record<string, string>;
}

const RDS_NS = 'http://rds.amazonaws.com/doc/2014-10-31/';
const scalar = (v: Attr | undefined): string | undefined => (v ? String(Object.values(v)[0]) : undefined);

export class FakeAwsData {
  readonly tables = new Map<string, FakeTable>();
  readonly dbInstances: FakeDbInstance[] = [];
  readonly dbClusters: FakeDbCluster[] = [];
  /** Every DynamoDB operation asked for, in order (with its table). */
  readonly ops: { op: string; table: string | null; body: Record<string, unknown> }[] = [];

  constructor(private readonly account: () => string) {}

  addTable(t: FakeTable): this {
    this.tables.set(t.name, t);
    return this;
  }

  private err(type: string, message: string, status = 400): Reply {
    return { status, headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-errortype': type }, body: { __type: `com.amazonaws.dynamodb.v20120810#${type}`, message } };
  }

  private table(name: unknown): FakeTable | Reply {
    const t = typeof name === 'string' ? this.tables.get(name) : undefined;
    return t ?? this.err('ResourceNotFoundException', `Requested resource not found: Table: ${String(name)} not found`);
  }

  private page(items: Record<string, Attr>[], limit: unknown, start: number, key: (i: number) => unknown) {
    const n = typeof limit === 'number' && limit > 0 ? limit : items.length;
    const slice = items.slice(start, start + n);
    const more = start + n < items.length;
    return { slice, next: more ? key(start + n) : undefined };
  }

  dynamodb(r: RecordedRequest): Reply {
    const op = (r.headers['x-amz-target'] ?? '').split('.').pop() ?? '';
    let b: Record<string, unknown> = {};
    try {
      b = r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {};
    } catch {
      return this.err('SerializationException', 'Malformed body');
    }
    this.ops.push({ op, table: typeof b.TableName === 'string' ? b.TableName : null, body: b });
    const ok = (body: unknown): Reply => ({ status: 200, headers: { 'content-type': 'application/x-amz-json-1.0' }, body });
    switch (op) {
      case 'ListTables': {
        const names = [...this.tables.keys()].sort().filter((n) => !b.ExclusiveStartTableName || n > String(b.ExclusiveStartTableName));
        const n = typeof b.Limit === 'number' ? b.Limit : 100;
        return ok({ TableNames: names.slice(0, n), ...(names.length > n ? { LastEvaluatedTableName: names[n - 1] } : {}) });
      }
      case 'DescribeTable': {
        const t = this.table(b.TableName);
        if ('status' in t) return t;
        const defs = [{ AttributeName: t.pk, AttributeType: t.pkType ?? 'S' }, ...(t.sk ? [{ AttributeName: t.sk, AttributeType: 'S' }] : []), ...(t.gsi ?? []).filter((g) => g.pk !== t.pk).map((g) => ({ AttributeName: g.pk, AttributeType: 'S' }))];
        return ok({ Table: { TableName: t.name, TableArn: `arn:aws:dynamodb:eu-central-1:${this.account()}:table/${t.name}`, TableStatus: 'ACTIVE', ItemCount: t.items.length, AttributeDefinitions: defs, KeySchema: [{ AttributeName: t.pk, KeyType: 'HASH' }, ...(t.sk ? [{ AttributeName: t.sk, KeyType: 'RANGE' }] : [])], ...(t.gsi?.length ? { GlobalSecondaryIndexes: t.gsi.map((g) => ({ IndexName: g.name, KeySchema: [{ AttributeName: g.pk, KeyType: 'HASH' }], IndexStatus: 'ACTIVE' })) } : {}) } });
      }
      case 'Scan': {
        const t = this.table(b.TableName);
        if ('status' in t) return t;
        const { slice } = this.page(t.items, b.Limit, 0, () => undefined);
        return ok({ Items: slice, Count: slice.length, ScannedCount: slice.length });
      }
      case 'Query': {
        const t = this.table(b.TableName);
        if ('status' in t) return t;
        const names = (b.ExpressionAttributeNames ?? {}) as Record<string, string>;
        const values = (b.ExpressionAttributeValues ?? {}) as Record<string, Attr>;
        const conds = String(b.KeyConditionExpression ?? '')
          .split(/\s+AND\s+/i)
          .map((c) => /^\s*(#?\w+)\s*=\s*(:\w+)\s*$/.exec(c))
          .filter((m): m is RegExpExecArray => !!m)
          .map((m) => ({ attr: names[m[1]!] ?? m[1]!, value: scalar(values[m[2]!]) }));
        const pkName = b.IndexName ? (t.gsi?.find((g) => g.name === b.IndexName)?.pk ?? t.pk) : t.pk;
        if (!conds.some((c) => c.attr === pkName)) return this.err('ValidationException', 'Query condition missed key schema element');
        const match = t.items.filter((it) => conds.every((c) => scalar(it[c.attr]) === c.value));
        const start = b.ExclusiveStartKey ? Number(scalar((b.ExclusiveStartKey as Record<string, Attr>).__offset) ?? 0) : 0;
        if (b.Select === 'COUNT') return ok({ Count: match.length, ScannedCount: match.length });
        const { slice, next } = this.page(match, b.Limit, start, (i) => ({ __offset: { N: String(i) } }));
        return ok({ Items: slice, Count: slice.length, ScannedCount: slice.length, ...(next ? { LastEvaluatedKey: next } : {}) });
      }
      case 'ExecuteStatement': {
        const st = String(b.Statement ?? '');
        const m = /^\s*SELECT\s+\*\s+FROM\s+"([^"]+)"(?:\."([^"]+)")?\s+WHERE\s+"?(\w+)"?\s*=\s*(\?|'([^']*)'|(\d+))\s*$/i.exec(st);
        if (!m) return this.err('ValidationException', `Statement not understood by the fake: ${st.slice(0, 80)}`);
        const t = this.table(m[1]);
        if ('status' in t) return t;
        const value = m[4] === '?' ? scalar(((b.Parameters as Attr[] | undefined) ?? [])[0]) : (m[5] ?? m[6]);
        const match = t.items.filter((it) => scalar(it[m[3]!]) === value);
        const start = b.NextToken ? Number(b.NextToken) : 0;
        const { slice, next } = this.page(match, b.Limit, start, (i) => String(i));
        return ok({ Items: slice, ...(next ? { NextToken: next } : {}) });
      }
    }
    return this.err('UnknownOperationException', `${op} is not answered by this fake.`);
  }

  private rdsOk(action: string, inner: string): Reply {
    return { status: 200, headers: { 'content-type': 'text/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><${action}Response xmlns="${RDS_NS}"><${action}Result>${inner}</${action}Result><ResponseMetadata><RequestId>req-data</RequestId></ResponseMetadata></${action}Response>` };
  }

  private tags(t?: Record<string, string>): string {
    return `<TagList>${Object.entries(t ?? {}).map(([k, v]) => `<Tag><Key>${xmlEsc(k)}</Key><Value>${xmlEsc(v)}</Value></Tag>`).join('')}</TagList>`;
  }

  /** RDS reads this fake keeps; null for an action `FakeAws` answers itself. */
  rds(action: string, region: string): Reply | null {
    if (action === 'DescribeDBInstances') {
      const xml = this.dbInstances
        .map((d) => `<DBInstance><DBInstanceIdentifier>${xmlEsc(d.id)}</DBInstanceIdentifier><DBInstanceArn>arn:aws:rds:${region}:${this.account()}:db:${xmlEsc(d.id)}</DBInstanceArn><Engine>${d.engine}</Engine><DBInstanceStatus>${d.status ?? 'available'}</DBInstanceStatus><Endpoint><Address>${xmlEsc(d.host)}</Address><Port>${d.port}</Port></Endpoint>${d.dbName ? `<DBName>${xmlEsc(d.dbName)}</DBName>` : ''}<MasterUsername>${xmlEsc(d.masterUser ?? 'admin')}</MasterUsername><PubliclyAccessible>${d.publiclyAccessible ? 'true' : 'false'}</PubliclyAccessible><IAMDatabaseAuthenticationEnabled>${d.iamAuth ? 'true' : 'false'}</IAMDatabaseAuthenticationEnabled>${d.cluster ? `<DBClusterIdentifier>${xmlEsc(d.cluster)}</DBClusterIdentifier>` : ''}${this.tags(d.tags)}</DBInstance>`)
        .join('');
      return this.rdsOk('DescribeDBInstances', `<DBInstances>${xml}</DBInstances>`);
    }
    if (action === 'DescribeDBClusters') {
      const xml = this.dbClusters
        .map((c) => `<DBCluster><DBClusterIdentifier>${xmlEsc(c.id)}</DBClusterIdentifier><DBClusterArn>arn:aws:rds:${region}:${this.account()}:cluster:${xmlEsc(c.id)}</DBClusterArn><Engine>${c.engine}</Engine><Status>available</Status><Endpoint>${xmlEsc(c.writer)}</Endpoint>${c.reader ? `<ReaderEndpoint>${xmlEsc(c.reader)}</ReaderEndpoint>` : ''}<Port>${c.port}</Port>${c.dbName ? `<DatabaseName>${xmlEsc(c.dbName)}</DatabaseName>` : ''}<MasterUsername>${xmlEsc(c.masterUser ?? 'admin')}</MasterUsername><IAMDatabaseAuthenticationEnabled>${c.iamAuth ? 'true' : 'false'}</IAMDatabaseAuthenticationEnabled>${this.tags(c.tags)}</DBCluster>`)
        .join('');
      return this.rdsOk('DescribeDBClusters', `<DBClusters>${xml}</DBClusters>`);
    }
    return null;
  }
}
