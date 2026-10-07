import { readdir, stat, unlink, readFile } from 'node:fs/promises';
import { safePath, atomicWrite, sha256 } from './vault-io.mjs';

const BASE = '.wiki-server/responses';
const MAX = 64_000;
const TTL = 24 * 60 * 60 * 1000;

/** Immutable, lossless overflow snapshots. They are transport caches, not fresh evidence. */
export async function responsePage(root, { snapshot_id, offset = 0, max_chars = 6000 }) {
  if (!/^[a-f0-9]{64}$/.test(snapshot_id ?? '') || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(max_chars) || max_chars < 100 || max_chars > 6000) throw Error('Invalid response continuation.');
  const target = await safePath(root, `${BASE}/${snapshot_id}.json`);
  if (Date.now() - (await stat(target)).mtimeMs > TTL) throw Error('Response snapshot expired; repeat the original query explicitly.');
  const text = await readFile(target, 'utf8');
  if (sha256(text) !== snapshot_id || offset > text.length) throw Error('Invalid response snapshot or offset.');
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1])) throw Error('Offset splits a Unicode surrogate pair.');
  let end = Math.min(text.length, offset + max_chars);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return { format: 'json_fragment', snapshot_id, offset, text: text.slice(offset, end), total_chars: text.length,
    next_offset: end < text.length ? end : null, truncated: end < text.length,
    continue_with: 'wiki_read_result', historical: true,
    instructions: 'Concatenate text chunks then JSON.parse once. Snapshot is the original response, not a fresh source check.' };
}

export async function boundedResponse(root, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (JSON.stringify(text).length <= MAX) return { content: [{ type: 'text', text }] };
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw Error('Response exceeds 16 MiB; narrow the query with its source, range or pagination selectors.');
  const serialized = typeof value === 'string' ? JSON.stringify(value) : text;
  const id = sha256(serialized);
  await atomicWrite(root, `${BASE}/${id}.json`, serialized);
  // Bound this reconstructible cache; never remove vault originals or notes.
  const directory = await safePath(root, BASE);
  const entries = [];
  for (const name of await readdir(directory)) if (/^[a-f0-9]{64}\.json$/.test(name)) {
    try {
      const target = await safePath(root, `${BASE}/${name}`), info = await stat(target);
      entries.push({ name, target, size: info.size, time: info.mtimeMs });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  entries.sort((a, b) => b.time - a.time);
  let bytes = 0;
  for (const [index, e] of entries.entries()) {
    bytes += e.size;
    if (e.name !== `${id}.json` && (index >= 32 || bytes > 32 * 1024 * 1024 || Date.now() - e.time > TTL)) await unlink(e.target).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  return { content: [{ type: 'text', text: JSON.stringify(await responsePage(root, { snapshot_id: id })) }] };
}
