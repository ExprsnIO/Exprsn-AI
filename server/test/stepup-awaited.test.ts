import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 1.9.0 (B-190) made requireRecentAuth's handler async. Used as route middleware Express 5 awaits it; a handler that
// calls it directly (`recent(req, res, ...)`) must await it, or a stale sign-in passes the step-up check unchecked
// (found in routes/atproto.ts on 2026-10-18). This test fails on any direct call of a step-up handler not awaited.
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });

describe('step-up checks called directly are awaited', () => {
  it('awaits every direct call of a requireRecentAuth handler', () => {
    const problems: string[] = [];
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'utf8');
      // names bound to requireRecentAuth(s): `const recent = requireRecentAuth(s)`
      const names = [...text.matchAll(/const\s+(\w+)\s*=\s*requireRecentAuth\(/g)].map((m) => m[1]!);
      text.split('\n').forEach((line, i) => {
        for (const n of names) {
          const call = new RegExp(`(^|[^\\w.])${n}\\(req\\b`);
          if (call.test(line) && !new RegExp(`await\\s+${n}\\(req\\b`).test(line)) problems.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
        }
        if (/requireRecentAuth\([^)]*\)\(req\b/.test(line) && !/await\s+requireRecentAuth/.test(line)) problems.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(problems).toEqual([]);
  });
});
