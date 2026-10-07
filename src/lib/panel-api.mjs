import { readFile } from 'node:fs/promises';
import { NoteStore } from './note-store.mjs';
import { SourceStore } from './source-store.mjs';
import { lockStatus, recoverAbandonedLock } from './vault-admin.mjs';
import { safePath } from './vault-io.mjs';
import { MAX_SOURCE_MIB } from './source-limits.mjs';

// Mirrors the knowledge server: the rules file is served only when it stays a focused document.
const RULES_MAX_BYTES = 65536;
const LIST_LIMIT_MAX = 200;
const LIST_LIMIT_DEFAULT = 50;
const SOURCE_LIMIT_MAX = 100;
const LOG_DEFAULT_LINES = 200;
const LOG_MAX_LINES = 2000;

/** A request the panel refused to interpret. Always the caller's fault, never a vault failure. */
export class PanelInputError extends Error {
  constructor(message) { super(message); this.name = 'PanelInputError'; this.code = 'INVALID_REQUEST'; }
}

/** A state conflict the operator must resolve, such as a lock that cannot be proven abandoned. */
export class PanelConflictError extends Error {
  constructor(message) { super(message); this.name = 'PanelConflictError'; this.code = 'PANEL_CONFLICT'; }
}

function integer(value, { name, fallback, min, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new PanelInputError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

function flag(value) {
  return value === true || value === 'true' || value === '1' || value === 'on';
}

function label(value, { name, max, required = false }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new PanelInputError(`${name} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new PanelInputError(`${name} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new PanelInputError(`${name} is required.`);
    return undefined;
  }
  if (trimmed.length > max) throw new PanelInputError(`${name} must be at most ${max} characters.`);
  return trimmed;
}

function stringValue(frontmatter, field) {
  const value = frontmatter?.[field];
  return typeof value === 'string' ? value : '';
}

// The list view never ships note bodies: a catalog page stays small and the reader fetches one note at a time.
function noteSummary(note) {
  return {
    relativePath: note.relativePath,
    title: note.title,
    type: note.type,
    archived: note.frontmatter?.archived === true,
    tags: note.tags ?? [],
    aliases: note.aliases ?? [],
    summary: stringValue(note.frontmatter, 'summary'),
    scope: stringValue(note.frontmatter, 'scope'),
    review_status: stringValue(note.frontmatter, 'review_status') || 'draft',
    sources: note.sources ?? [],
    last_updated: stringValue(note.frontmatter, 'last_updated') || null,
    revision: note.revision,
  };
}

async function readVaultText(root, relative) {
  try { return await readFile(await safePath(root, relative), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/**
 * Read-only administrative view over one vault, plus the two maintenance operations the service
 * already defines. Every knowledge read goes through NoteStore/SourceStore so the panel shares the
 * knowledge server's lock, transaction recovery and interpretation rules; nothing here writes notes
 * or original material.
 */
export class PanelApi {
  constructor(root, { version = 'unknown' } = {}) {
    this.root = root;
    this.version = version;
    this.notes = new NoteStore(root);
    // Same wiring as the knowledge server: a locked source read first finishes any pending journal.
    this.sources = new SourceStore(root, { beforeLockedAction: () => this.notes.recover() });
  }

  async describe() {
    return {
      service: 'project-wiki-server',
      panel_version: this.version,
      vault: this.root,
      note_editing: false,
      source_importing: false,
      arbitrary_commands: false,
      locked_reads: ['status', 'lint', 'read_note', 'note_history', 'check_sources'],
      maintenance_actions: ['rebuild_index', 'recover_lock'],
      limits: {
        max_source_mib: MAX_SOURCE_MIB,
        note_list_limit_max: LIST_LIMIT_MAX,
        source_list_limit_max: SOURCE_LIMIT_MAX,
        rules_max_bytes: RULES_MAX_BYTES,
      },
      note: 'Reads that need a consistent catalog take the same cross-process vault lock as the MCP tools and may complete an already-planned transaction. The panel never edits notes, never imports sources and never runs commands.',
    };
  }

  lock() { return lockStatus(this.root); }

  status() { return this.notes.status(); }

  lint() { return this.notes.lint(); }

  async listNotes({ query, offset, limit, include_archived } = {}) {
    const start = integer(offset, { name: 'offset', fallback: 0, min: 0, max: 1_000_000 });
    const count = integer(limit, { name: 'limit', fallback: LIST_LIMIT_DEFAULT, min: 1, max: LIST_LIMIT_MAX });
    const archived = flag(include_archived);
    const searched = label(query, { name: 'query', max: 4000 });
    if (searched) {
      const hits = await this.notes.search(searched, count, archived);
      return {
        mode: 'search', query: searched, include_archived: archived, total: hits.length, offset: 0, next_offset: null,
        entries: hits.map(hit => ({ ...noteSummary({ ...hit, frontmatter: hit }), score: hit.score, snippet: hit.snippet })),
      };
    }
    // A plain listing is a lock-free read of the note files; it does not need a transaction view.
    const all = (await this.notes.catalog()).filter(note => archived || note.frontmatter.archived !== true).map(noteSummary);
    const entries = all.slice(start, start + count);
    return {
      mode: 'catalog', query: null, include_archived: archived, total: all.length, offset: start,
      next_offset: start + entries.length < all.length ? start + entries.length : null, entries,
    };
  }

  readNote({ pathOrTitle }) {
    return this.notes.read(label(pathOrTitle, { name: 'pathOrTitle', max: 4096, required: true }));
  }

  history({ pathOrTitle, revision }) {
    return this.notes.history(
      label(pathOrTitle, { name: 'pathOrTitle', max: 4096, required: true }),
      label(revision, { name: 'revision', max: 64 }),
    );
  }

  index({ include_archived } = {}) {
    return this.notes.index(flag(include_archived)).then(markdown => ({ include_archived: flag(include_archived), markdown }));
  }

  listSources({ offset, limit } = {}) {
    return this.sources.listSources({
      offset: integer(offset, { name: 'offset', fallback: 0, min: 0, max: 1_000_000 }),
      limit: integer(limit, { name: 'limit', fallback: LIST_LIMIT_DEFAULT, min: 1, max: SOURCE_LIMIT_MAX }),
    });
  }

  checkSources() { return this.sources.checkSources(); }

  async rules() {
    const content = await readVaultText(this.root, 'AGENTS.md');
    if (content === null) throw Object.assign(new Error('AGENTS.md is missing from this vault.'), { code: 'NOTE_NOT_FOUND' });
    if (Buffer.byteLength(content, 'utf8') > RULES_MAX_BYTES) throw new Error('Rules exceed 64 KiB; provide a focused rules file before serving.');
    return { markdown: content };
  }

  async activity({ lines } = {}) {
    const count = integer(lines, { name: 'lines', fallback: LOG_DEFAULT_LINES, min: 1, max: LOG_MAX_LINES });
    const content = await readVaultText(this.root, 'wiki/log.md');
    if (content === null) return { available: false, total_lines: 0, returned: 0, lines: [] };
    const all = content.replace(/\r\n/g, '\n').split('\n');
    if (all.length > 1 && all.at(-1) === '') all.pop();
    const tail = all.slice(Math.max(0, all.length - count));
    return { available: true, total_lines: all.length, returned: tail.length, lines: tail };
  }

  async rebuildIndex({ confirm } = {}) {
    if (confirm !== true) throw new PanelInputError('Maintenance actions require a JSON body of {"confirm": true}.');
    const result = await this.notes.rebuild();
    return { action: 'rebuild_index', ...result };
  }

  async recoverLock({ confirm } = {}) {
    if (confirm !== true) throw new PanelInputError('Maintenance actions require a JSON body of {"confirm": true}.');
    let result;
    try { result = await recoverAbandonedLock(this.root); }
    catch (error) { throw new PanelConflictError(error.message); }
    return { action: 'recover_lock', ...result };
  }
}

export async function createPanelApi(root, { version } = {}) {
  let resolved = version;
  if (!resolved) {
    try { resolved = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version; }
    catch { resolved = 'unknown'; }
  }
  return new PanelApi(root, { version: resolved });
}
