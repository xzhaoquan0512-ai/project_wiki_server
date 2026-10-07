import { NoteStore } from './note-store.mjs';
import { FulltextStore } from './fulltext-store.mjs';
import { readJson, safePath, sha256 } from './vault-io.mjs';
import { readFile } from 'node:fs/promises';

const STATE = '.wiki-server/compilation.json';
const chunkSize = 20;

/** Progress is the caller's assessment, tied to immutable source and exact note revisions. */
export class CompilationStore {
  constructor(root) { this.root = root; this.notes = new NoteStore(root); this.fulltext = new FulltextStore(root); }
  async state() { return readJson(this.root, STATE, { version: 1, records: {} }); }
  async queue({ status = 'pending', offset = 0, limit = 20 } = {}) {
    const saved = await this.state();
    if (saved.version !== 1 || !saved.records) throw Error('Invalid compilation state');
    const sources = await this.fulltext.status();
    const tasks = [];
    for (const source of sources.sources) {
      if (source.integrity !== 'ok') continue;
      const hash = source.id.slice(7);
      const ranges = source.indexed ? Array.from({ length: Math.ceil(source.page_count / chunkSize) }, (_, i) => ({ start_page: i * chunkSize + 1, end_page: Math.min((i + 1) * chunkSize, source.page_count) })) : [{ start_page: null, end_page: null }];
      for (const range of ranges) {
        const id = `${hash}:${range.start_page ?? 'source'}-${range.end_page ?? 'source'}`;
        const record = saved.records[id];
        let current = Boolean(record);
        if (record) for (const note of record.notes) {
          try { if (sha256(await readFile(await safePath(this.root, note.path))) !== note.revision) current = false; }
          catch { current = false; }
        }
        tasks.push({ id, source_id: source.id, path: source.path, ...range, status: !record ? 'pending' : !current ? 'needs_review' : record.status, record: record ?? null, record_revision: record ? sha256(JSON.stringify(record)) : null, needs_visual_pages: source.needs_visual_pages.filter(p => p >= range.start_page && p <= range.end_page) });
      }
    }
    const selected = status === 'all' ? tasks : tasks.filter(task => task.status === status);
    return { total_tasks: tasks.length, counts: { pending: tasks.filter(t => t.status === 'pending').length, summarized: tasks.filter(t => t.status === 'summarized').length, needs_review: tasks.filter(t => t.status === 'needs_review').length }, entries: selected.slice(offset, offset + limit), total: selected.length, next_offset: offset + limit < selected.length ? offset + limit : null, warning: 'summarized is a caller-reported draft compilation; it is not independent review, complete diagram analysis, or hardware verification.' };
  }
  async record({ task_id, status, notes, coverage_note, expected_revision }) {
    if (!['summarized', 'needs_review'].includes(status) || !Array.isArray(notes) || notes.length < 1 || notes.length > 30 || typeof coverage_note !== 'string' || coverage_note.trim().length < 20 || coverage_note.length > 12000) throw Error('Provide notes and an explicit coverage assessment');
    const all = []; let offset = 0;
    do { const q = await this.queue({ status: 'all', offset, limit: 100 }); all.push(...q.entries); offset = q.next_offset; } while (offset !== null);
    const task = all.find(t => t.id === task_id); if (!task) throw Error('Unknown or changed source task');
    const references = [];
    for (const reference of notes) {
      const note = await this.notes.read(reference);
      if (!note.frontmatter?.sources?.some(s => s === task.path || s === task.source_id)) throw Error('Each output note must cite the task source');
      references.push({ path: note.relativePath, revision: note.revision });
    }
    return this.notes.locked(async () => {
      let old = null;
      try { old = await readFile(await safePath(this.root, STATE)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const before = old === null ? null : JSON.parse(old);
      const saved = before ?? { version: 1, records: {} };
      const previous = saved.records[task_id];
      const revision = previous ? sha256(JSON.stringify(previous)) : null;
      if (expected_revision !== revision) throw Error('Compilation progress changed; read queue and retry with record_revision');
      for (const note of references) if (sha256(await readFile(await safePath(this.root, note.path))) !== note.revision) throw Error('Output note changed during recording');
      if (sha256(await readFile(await safePath(this.root, task.path))) !== task.source_id.slice(7)) throw Error('Source changed during recording');
      const value = { status, notes: references, coverage_note: coverage_note.trim(), recorded_at: new Date().toISOString() };
      saved.records[task_id] = value;
      const log = await readFile(await safePath(this.root, 'wiki/log.md'), 'utf8');
      const nextLog = `${log.trimEnd()}\n\n- ${value.recorded_at} record-compilation: ${task_id}; ${status}; ${JSON.stringify(references.map(n => n.path))}; caller-reported scope, not automatic factual verification.\n`;
      await this.notes.commitFiles('record-compilation', new Map([[STATE, JSON.stringify(saved, null, 2) + '\n'], ['wiki/log.md', nextLog]]), new Map([[STATE, old === null ? null : sha256(old)], ['wiki/log.md', sha256(log)]]));
      return { task_id, ...value, record_revision: sha256(JSON.stringify(value)), warning: 'Caller assessment recorded; source and note identity checked, semantic correctness not automatically verified.' };
    });
  }
}
