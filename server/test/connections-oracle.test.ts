/*
 * 1.9.0: Oracle connections without a database: the classifier (reads, every refusal family, q-quoting), object
 * names against the allow-list, saved-query binding in the Oracle dialect, the connect descriptor and the TLS
 * refusal before dialling.
 */
import { describe, expect, it } from 'vitest';
import { classifyOracle } from '../src/connections/classify-oracle.js';
import { allowedQualified, canonical, type NameContext } from '../src/connections/dialects.js';
import type { ConnectionSpec } from '../src/connections/drivers.js';
import { OracleDriver, oracleConnectOptions, oracleDescriptor, oracleNumber, quoteOracleIdent } from '../src/connections/oracle.js';
import { renderSql, sqlPieces } from '../src/connections/saved-queries.js';
import { parseAllowList } from '../src/mcp/hosts.js';

describe('Oracle classifier', () => {
  it('reads selects, joins, CTEs, set operators and flashback queries, with their objects', () => {
    expect(classifyOracle('SELECT e.ename, d.dname FROM hr.emp e JOIN hr.dept d ON e.deptno = d.deptno WHERE e.sal > :1')).toMatchObject({ kind: 'read', verb: 'SELECT', objects: ['hr.emp', 'hr.dept'] });
    expect(classifyOracle('WITH x AS (SELECT * FROM orders) SELECT * FROM x;')).toMatchObject({ kind: 'read', objects: ['orders'] });
    expect(classifyOracle('SELECT a FROM t MINUS SELECT a FROM u')).toMatchObject({ kind: 'read', objects: ['t', 'u'] });
    expect(classifyOracle("SELECT * FROM emp AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '1' HOUR)")).toMatchObject({ kind: 'read', objects: ['emp'] });
    expect(classifyOracle('SELECT * FROM emp SAMPLE (10) FETCH FIRST 5 ROWS ONLY')).toMatchObject({ kind: 'read', objects: ['emp'] });
    expect(classifyOracle('SELECT * FROM "HR"."Mixed Case"')).toMatchObject({ kind: 'read', objects: ['HR.Mixed Case'] });
    expect(classifyOracle('SELECT * FROM emp#hist')).toMatchObject({ kind: 'read', objects: ['emp#hist'] });
    expect(classifyOracle('SELECT /*+ FULL(e) */ * FROM emp e -- note\n')).toMatchObject({ kind: 'read', objects: ['emp'] });
    expect(classifyOracle('SELECT sys_context(\'USERENV\', \'SESSION_USER\') FROM dual')).toMatchObject({ kind: 'read', objects: [] });
    expect(classifyOracle('SELECT 1 FROM emp\n/')).toMatchObject({ kind: 'read', objects: ['emp'] });
  });

  it('never reads a keyword inside q-quoted, N or plain strings', () => {
    expect(classifyOracle("SELECT q'[it's; DELETE FROM emp]' FROM emp")).toMatchObject({ kind: 'read', objects: ['emp'] });
    expect(classifyOracle("SELECT nq'{UTL_HTTP.request('x')}' FROM emp")).toMatchObject({ kind: 'read', objects: ['emp'] });
    expect(classifyOracle("SELECT N'dbms_lock' , 'x@y' FROM emp")).toMatchObject({ kind: 'read', objects: ['emp'] });
    expect(classifyOracle("SELECT q'[unterminated FROM emp")).toMatchObject({ kind: 'unparsed' });
  });

  it('refuses several statements, PL/SQL, writes, DDL and session statements', () => {
    expect(classifyOracle('SELECT 1 FROM emp; SELECT 2 FROM emp')).toMatchObject({ kind: 'multiple' });
    expect(classifyOracle('SELECT 1 FROM emp\n/\nDELETE FROM emp\n/')).toMatchObject({ kind: 'multiple' });
    for (const q of ['BEGIN NULL; END;', 'DECLARE x NUMBER; BEGIN NULL; END;']) expect(classifyOracle(q)).toMatchObject({ kind: 'write' });
    for (const [q, verb] of [
      ['INSERT INTO emp VALUES (1)', 'INSERT'],
      ['INSERT ALL INTO a VALUES (1) INTO b VALUES (2) SELECT * FROM dual', 'INSERT'],
      ['UPDATE emp SET sal = 0', 'UPDATE'],
      ['DELETE emp', 'DELETE'],
      ['MERGE INTO emp USING src ON (1 = 1) WHEN MATCHED THEN UPDATE SET sal = 0', 'MERGE'],
      ['LOCK TABLE emp IN EXCLUSIVE MODE', 'LOCK'],
      ['CALL proc()', 'CALL'],
      ['EXEC proc', 'EXEC'],
      ['EXPLAIN PLAN FOR SELECT * FROM emp', 'EXPLAIN PLAN'],
      ['SELECT * FROM emp FOR UPDATE', 'SELECT FOR UPDATE'],
      ['SELECT my_seq.NEXTVAL FROM dual', 'NEXTVAL']
    ]) expect(classifyOracle(q!)).toMatchObject({ kind: 'write', verb });
    for (const q of ['CREATE TABLE t (a NUMBER)', 'ALTER SESSION SET nls_date_format = \'YYYY\'', 'DROP TABLE emp PURGE', 'TRUNCATE TABLE emp', 'GRANT SELECT ON emp TO x', 'REVOKE SELECT ON emp FROM x', 'COMMENT ON TABLE emp IS \'x\'', 'RENAME a TO b', 'PURGE RECYCLEBIN', 'FLASHBACK TABLE emp TO BEFORE DROP', 'SET ROLE ALL', 'ANALYZE TABLE emp COMPUTE STATISTICS', 'AUDIT SELECT ON emp', 'COMMIT', 'ROLLBACK', 'SAVEPOINT a']) expect(classifyOracle(q)).toMatchObject({ kind: 'ddl' });
  });

  it('refuses network, file and internal packages, URI types and database links', () => {
    for (const q of ["SELECT UTL_HTTP.request('http://x') FROM dual", 'SELECT utl_inaddr.get_host_address FROM dual', "SELECT DBMS_XMLGEN.getxml('select 1 from dual') FROM dual", 'SELECT sys.dbms_lock.sleep(5) FROM dual', "SELECT HTTPURITYPE('http://x').getclob() FROM dual", "SELECT DBURITYPE('/HR/EMP').getxml() FROM dual", "SELECT XDBURITYPE('/x').getclob() FROM dual", "SELECT * FROM TABLE(utl_file.fopen('d', 'f', 'r'))"]) expect(classifyOracle(q)).toMatchObject({ kind: 'denied' });
    expect(classifyOracle('SELECT * FROM emp@remote_db')).toMatchObject({ kind: 'denied', denied: '@remote_db' });
    expect(classifyOracle('SELECT * FROM hr.emp @ "Other.Link"')).toMatchObject({ kind: 'denied', denied: '@other.link' });
  });
});

describe('Oracle object names', () => {
  const c: NameContext = { engine: 'oracle', database: 'FREEPDB1', account: 'REPORTER', options: {} };
  const allow = ['HR.EMPLOYEES', 'REPORTER.SUMMARY'];

  it('resolves unqualified names to the account, or to the configured schema', () => {
    expect(canonical('summary', c)).toBe('reporter.summary');
    expect(allowedQualified('summary', allow, c)).toBe(true);
    expect(allowedQualified('hr.employees', allow, c)).toBe(true);
    expect(allowedQualified('employees', allow, c)).toBe(false);
    const hr = { ...c, options: { schema: 'HR' } };
    expect(allowedQualified('employees', allow, hr)).toBe(true);
    expect(allowedQualified('summary', allow, hr)).toBe(false);
    // A classified query's objects are checked the same way.
    expect(classifyOracle('SELECT * FROM employees e JOIN hr.departments d ON 1 = 1').objects.map((o) => allowedQualified(o, allow, hr))).toEqual([true, false]);
  });
});

describe('Oracle saved-query binding', () => {
  const defs = [
    { name: 'dept', type: 'number' as const, required: true },
    { name: 'ids', type: 'list' as const, required: true },
    { name: 'col', type: 'identifier' as const, required: true, allowed: ['ENAME', 'JOB'] }
  ];

  it('writes :1…:n, one per use, lists expanded, and leaves q-quoted text alone', () => {
    const sql = "SELECT :col FROM emp WHERE deptno = :dept AND id IN (:ids) AND mgr_dept = :dept AND note <> q'[:dept]'";
    const names = new Set(defs.map((d) => d.name));
    const { pieces, used } = sqlPieces(sql, 'oracle', names);
    expect([...used].sort()).toEqual(['col', 'dept', 'ids']);
    expect(renderSql(pieces, 'oracle', defs as never, { dept: 10, ids: [1, 2], col: 'ENAME' })).toEqual({ text: `SELECT "ENAME" FROM emp WHERE deptno = :1 AND id IN (:2, :3) AND mgr_dept = :4 AND note <> q'[:dept]'`, params: [10, 1, 2, 10] });
  });
});

describe('Oracle driver, without a server', () => {
  const spec: ConnectionSpec = { engine: 'oracle', endpoint: 'db.internal:1522', database: 'FREEPDB1', tls: false, username: 'reporter', password: 'pw', options: {} };

  it('builds the descriptor for the checked address and refuses anything that could change it', () => {
    expect(oracleDescriptor({ address: '10.0.0.5', port: 1522, service: 'FREEPDB1', tls: false })).toBe('(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=10.0.0.5)(PORT=1522))(CONNECT_DATA=(SERVICE_NAME=FREEPDB1)))');
    expect(oracleDescriptor({ address: 'fd00::5', port: 2484, service: 'sales.example', tls: true })).toContain('(PROTOCOL=TCPS)(HOST=fd00::5)(PORT=2484)');
    expect(() => oracleDescriptor({ address: '10.0.0.5', port: 1521, service: 'X)(HOST=evil', tls: false })).toThrow(/service name/);
    expect(() => oracleDescriptor({ address: 'evil.example', port: 1521, service: 'X', tls: false })).toThrow(/IP address/);
  });

  it('dials with the timeouts, and with TLS only when the certificate DN is given', () => {
    expect(oracleConnectOptions(spec, '10.0.0.5', 1522, 4500)).toMatchObject({ user: 'reporter', connectTimeout: 5, transportConnectTimeout: 5, connectString: expect.stringContaining('HOST=10.0.0.5') });
    expect(() => oracleConnectOptions({ ...spec, tls: true }, '10.0.0.5', 2484, 5000)).toThrow(/distinguished name/);
    expect(oracleConnectOptions({ ...spec, tls: true, options: { sslServerCertDN: 'CN=db.internal,O=Example' } }, '10.0.0.5', 2484, 5000)).toMatchObject({ sslServerDNMatch: true, sslServerCertDN: 'CN=db.internal,O=Example', connectString: expect.stringContaining('TCPS') });
  });

  it('refuses TLS without a DN before resolving or dialling', async () => {
    const d = new OracleDriver({ ...spec, endpoint: 'does-not-resolve.invalid:2484', tls: true }, parseAllowList(''));
    await expect(d.test(2000)).rejects.toThrow(/distinguished name/);
  });

  it('refuses a public host before dialling', async () => {
    const d = new OracleDriver({ ...spec, endpoint: '8.8.8.8:1521' }, parseAllowList(''));
    await expect(d.test(2000)).rejects.toThrow(/public address/);
  });

  it('keeps numbers exact and quotes names', () => {
    expect(oracleNumber('42')).toBe(42);
    expect(oracleNumber('-0.125')).toBe(-0.125);
    expect(oracleNumber('12345678901234567890')).toBe('12345678901234567890');
    expect(oracleNumber('0.12345678901234567890')).toBe('0.12345678901234567890');
    expect(oracleNumber(null)).toBeNull();
    expect(quoteOracleIdent('HR.EMPLOYEES')).toBe('"HR"."EMPLOYEES"');
    expect(() => quoteOracleIdent('a"b')).toThrow();
  });
});
