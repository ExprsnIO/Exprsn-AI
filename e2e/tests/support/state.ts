import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// E2E_STATE_DIR lets two runs (two worktrees' agents, or a spec being written beside a full run) keep apart.
export const STATE_DIR = process.env.E2E_STATE_DIR ? path.resolve(process.env.E2E_STATE_DIR) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.state');
export const SERVER_STATE = path.join(STATE_DIR, 'server.json');

export type User = 'root' | 'root2' | 'ops' | 'mladmin' | 'member' | 'enrol';

export interface ServerState {
  url: string;
  password: string;
  tenant: string;
  workspace: { id: string; name: string };
  totp: Record<string, string>;
  fakes: { ollama: string; mcp: string; acme: string; fmSocket: string };
  users: User[];
  /** The server's BLOB_DIR (filesystem blob store). */
  blobDir: string;
}

let cached: ServerState | null = null;
export function serverState(): ServerState {
  if (!cached) cached = JSON.parse(readFileSync(SERVER_STATE, 'utf8')) as ServerState;
  return cached;
}

export const authFile = (user: User): string => path.join(STATE_DIR, `auth-${user}.json`);
