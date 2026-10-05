/*
 * B-3301: `docs/permissions.md` is generated from the permission catalogue and the route permission registry, and
 * the suite fails when the file differs from what the code says (route-registry.test.ts). Regenerate it with:
 *
 *   npm run docs:permissions
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { permissionsMarkdown } from '../src/authz/matrix.js';

export const PERMISSIONS_DOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/permissions.md');

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv.includes('--write')) {
  writeFileSync(PERMISSIONS_DOC, permissionsMarkdown());
  process.stdout.write(`wrote ${path.relative(process.cwd(), PERMISSIONS_DOC)}\n`);
}
