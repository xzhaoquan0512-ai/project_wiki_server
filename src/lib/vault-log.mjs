import { readFile } from 'node:fs/promises';
import { safePath } from './vault-io.mjs';

// The audit log is append-only text written inside the vault lock. Reading it needs no lock:
// every commit replaces the file atomically, so a reader sees a complete older or newer file.
export const LOG_LINES_DEFAULT = 200;
export const LOG_LINES_MAX = 2000;

export async function readLogTail(root, { lines = LOG_LINES_DEFAULT } = {}) {
  if (!Number.isInteger(lines) || lines < 1 || lines > LOG_LINES_MAX) {
    throw new Error(`lines must be an integer from 1 to ${LOG_LINES_MAX}.`);
  }
  let content = null;
  try { content = await readFile(await safePath(root, 'wiki/log.md'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (content === null) return { available: false, total_lines: 0, returned: 0, lines: [] };
  const all = content.replace(/\r\n/g, '\n').split('\n');
  if (all.length > 1 && all.at(-1) === '') all.pop();
  const tail = all.slice(Math.max(0, all.length - lines));
  return {
    available: true, total_lines: all.length, returned: tail.length, lines: tail,
    note: 'Audit text of recorded operations; an entry records what the service did, not independent verification of the result.',
  };
}
