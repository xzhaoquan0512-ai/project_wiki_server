import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import matter from './frontmatter.mjs';
import { withVaultLock, safePath, readJson, writeJson, atomicWrite, sha256 } from './vault-io.mjs';
import { resolveSourceReferences } from './source-store.mjs';

const CATEGORIES = ['concepts', 'entities', 'syntheses'];
const START = '<!-- LLMWIKI_INDEX_START -->';
const END = '<!-- LLMWIKI_INDEX_END -->';
const key = value => value.trim().replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
const now = () => new Date().toISOString();
const notePath = value => /^wiki\/(concepts|entities|syntheses)\/(?:[^/]+\/)*[^/]+\.md$/i.test(value);

function failure(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
function titleValue(title) {
  const clean = title.trim();
  if (!clean || clean.length > 180 || /[\\/:*?"<>|\[\]#\x00-\x1f]/.test(clean) || /[. ]$/.test(clean)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) {
    throw failure('INVALID_TITLE', 'Use a nonempty title without path separators, wikilink syntax, control characters or reserved filename characters.');
  }
  return clean;
}
function noteNames(note) {
  const relative = note.relativePath;
  return new Set([note.title, ...note.aliases, relative, relative.replace(/^wiki\//, ''), path.posix.basename(relative)].map(key));
}
function assertRevision(note, expected) {
  if (!expected || expected !== note.revision) throw failure('REVISION_CONFLICT', 'Read the current note and pass its revision as expected_revision before changing it.', {
    relativePath: note.relativePath, current_revision: note.revision,
  });
}
function assertNoAmbiguity(notes) {
  const seen = new Map();
  for (const note of notes) {
    titleValue(note.title);
    for (const alias of note.aliases) titleValue(alias);
    for (const name of noteNames(note)) {
      const other = seen.get(name);
      if (other && other !== note.relativePath) throw failure('AMBIGUOUS_NOTE', `Title, alias or filename "${name}" resolves to multiple notes.`, { paths: [other, note.relativePath] });
      seen.set(name, note.relativePath);
    }
  }
}
function parseNote(relativePath, rawMarkdown) {
  const parsed = matter(rawMarkdown);
  const fm = parsed.data;
  const title = typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim() : parsed.content.match(/^#\s+([^\r\n]+)/m)?.[1].trim() || path.posix.basename(relativePath, '.md');
  for (const field of ['aliases', 'tags', 'sources']) {
    if (fm[field] !== undefined && (!Array.isArray(fm[field]) || !fm[field].every(value => typeof value === 'string'))) throw failure('INVALID_FRONTMATTER', `${field} must be an array of strings.`);
  }
  const type = relativePath.startsWith('wiki/concepts/') ? 'concept' : relativePath.startsWith('wiki/entities/') ? 'entity' : 'synthesis';
  const frontmatter = { ...fm, title, type, aliases: fm.aliases || [], tags: fm.tags || [], sources: fm.sources || [] };
  return { relativePath, title, type, aliases: frontmatter.aliases, tags: frontmatter.tags, sources: frontmatter.sources, frontmatter, content: parsed.content, rawMarkdown, revision: sha256(rawMarkdown) };
}
async function optionalText(root, relative) {
  try { return await readFile(await safePath(root, relative), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function resolveNote(notes, identifier) {
  if (!identifier.trim()) throw failure('INVALID_IDENTIFIER', 'Note identifier must not be empty.');
  const exact = notes.find(note => key(note.relativePath) === key(identifier));
  if (exact) return exact;
  const matches = notes.filter(note => noteNames(note).has(key(identifier)));
  if (matches.length > 1) throw failure('AMBIGUOUS_NOTE', 'Use the exact note path to resolve this ambiguous identifier.', { paths: matches.map(note => note.relativePath) });
  if (!matches.length) throw failure('NOTE_NOT_FOUND', `Note not found: ${identifier}`);
  return matches[0];
}

async function resolveHistoricalIdentity(root, notes, identifier) {
  try { return resolveNote(notes, identifier); }
  catch (error) {
    if (error.code !== 'NOTE_NOT_FOUND') throw error;
    if (!notePath(identifier)) throw failure('NOTE_NOT_FOUND', 'Note not found. To inspect or restore a deleted note, pass its original exact wiki/.../*.md path.');
    await safePath(root, identifier, { allowMissing: true });
    if (await optionalText(root, identifier) !== null) throw failure('UNSUPPORTED_NOTE_PATH', 'The requested path exists but is not available as a regular wiki note.');
    return { relativePath: identifier, revision: null, deleted: true };
  }
}

// Mask comments, fenced/indented code, inline code, Markdown destinations and URLs,
// keeping character positions stable. Only true wikilinks can then be rewritten.
function maskedMarkdown(markdown) {
  let text = markdown.replace(/<!--[\s\S]*?-->/g, value => value.replace(/[^\n]/g, ' '));
  let fence = null;
  text = text.split('\n').map(line => {
    const marker = line.match(/^(?: {0,3}> ?)* {0,3}(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = null;
      return ' '.repeat(line.length);
    }
    if (marker) { fence = marker[1]; return ' '.repeat(line.length); }
    if (/^(?: {4}|\t)/.test(line)) return ' '.repeat(line.length);
    return line;
  }).join('\n');
  text = text.replace(/(`+)[\s\S]*?\1/g, value => value.replace(/[^\n]/g, ' '));
  text = text.replace(/\]\([^\n]*?\)/g, value => ' '.repeat(value.length));
  return text.replace(/(?:https?:\/\/|mailto:)[^\s<>]+/g, value => ' '.repeat(value.length));
}
export function rewriteWikilinks(markdown, source, targetTitle) {
  const names = noteNames(source);
  const masked = maskedMarkdown(markdown);
  const replacements = [];
  const pattern = /(?<!!)\[\[([^\]\n]+)\]\]/g;
  let match;
  while ((match = pattern.exec(masked))) {
    const inner = markdown.slice(match.index + 2, match.index + match[0].length - 2);
    const split = inner.search(/[|#]/);
    const name = split < 0 ? inner : inner.slice(0, split);
    if (names.has(key(name))) replacements.push({ start: match.index, end: match.index + match[0].length, text: `[[${targetTitle}${split < 0 ? '' : inner.slice(split)}]]` });
  }
  let result = markdown;
  for (const change of replacements.reverse()) result = result.slice(0, change.start) + change.text + result.slice(change.end);
  return result;
}
function outgoing(note) {
  const links = [];
  const masked = maskedMarkdown(note.content);
  for (const match of masked.matchAll(/(?<!!)\[\[([^\]\n]+)\]\]/g)) {
    const [destination, alias] = match[1].split('|');
    const [target, ...anchor] = destination.split('#');
    if (target.trim()) links.push({ raw: match[0], target: target.trim(), ...(alias ? { alias } : {}), ...(anchor.length ? { anchor: anchor.join('#') } : {}) });
  }
  return links;
}

export class NoteStore {
  constructor(root) { this.root = root; }
  async locked(action) {
    return withVaultLock(this.root, async () => { await this.recover(); return action(); });
  }
  async catalog() {
    const notes = [];
    const visit = async dir => {
      let entries;
      try { entries = await readdir(await safePath(this.root, dir), { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw failure('UNSUPPORTED_NOTE_PATH', 'Symlinks are not supported in the note tree.');
        if (entry.isDirectory()) { await visit(`${dir}/${entry.name}`); continue; }
        if (!entry.name.toLowerCase().endsWith('.md')) continue;
        if (!entry.isFile()) throw failure('UNSUPPORTED_NOTE_PATH', 'Notes must be regular files, not symlinks or directories.');
        const relative = `${dir}/${entry.name}`;
        notes.push(parseNote(relative, await readFile(await safePath(this.root, relative), 'utf8')));
      }
    };
    for (const category of CATEGORIES) await visit(`wiki/${category}`);
    return notes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }
  async recover() {
    let entries;
    try { entries = await readdir(await safePath(this.root, '.wiki-server/transactions')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const file of entries.filter(name => /^[a-f0-9-]+\.json$/.test(name)).sort()) {
      const relative = `.wiki-server/transactions/${file}`;
      const journal = await readJson(this.root, relative, null);
      if (journal?.status === 'committed') continue;
      if (!journal || journal.version !== 1 || !Array.isArray(journal.writes)) throw failure('TRANSACTION_BLOCKED', `Invalid transaction journal: ${relative}`);
      await this.replay(relative, journal);
    }
  }
  async replay(relative, journal) {
    // Preflight the complete transaction before resuming; unrelated edits block replay.
    const inspect = async write => {
      if (!(notePath(write.path) || ['wiki/index.md', 'wiki/log.md', '.wiki-server/sources.json', '.wiki-server/compilation.json'].includes(write.path)
          || /^\.wiki-server\/history\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/.test(write.path))) {
        throw failure('TRANSACTION_BLOCKED', 'Transaction contains an unsupported output path.');
      }
      if (typeof write.after !== 'string' || sha256(write.after) !== write.after_revision) throw failure('TRANSACTION_BLOCKED', 'Transaction content digest is invalid.');
      const current = await optionalText(this.root, write.path);
      const revision = current === null ? null : sha256(current);
      if (revision !== write.before_revision && revision !== write.after_revision) throw failure('TRANSACTION_BLOCKED', `Pending transaction conflicts with an external change to ${write.path}. Preserve the journal and resolve manually.`, { transaction: relative, current_revision: revision });
      return revision;
    };
    for (const write of journal.writes) await inspect(write);
    for (const write of journal.writes) {
      if (await inspect(write) !== write.after_revision) await atomicWrite(this.root, write.path, write.after);
    }
    await writeJson(this.root, relative, { ...journal, status: 'committed', completed_at: now() });
  }
  async commit(operation, title, changes, details = [], baseline = null) {
    const beforeNotes = await this.catalog();
    if (baseline) {
      for (const relative of changes.keys()) {
        const expected = baseline.find(note => note.relativePath === relative)?.revision ?? null;
        const current = beforeNotes.find(note => note.relativePath === relative)?.revision ?? null;
        if (expected !== current) throw failure('REVISION_CONFLICT', 'A note changed outside this MCP process while preparing the transaction.', { relativePath: relative, current_revision: current });
      }
    }
    const afterMap = new Map(beforeNotes.map(note => [note.relativePath, note]));
    for (const [relative, markdown] of changes) afterMap.set(relative, parseNote(relative, markdown));
    const afterNotes = [...afterMap.values()];
    assertNoAmbiguity(afterNotes);
    const planned = new Map();
    // Keep the revision of the bytes that were actually used to derive each output.
    // A second read in commitFiles must not silently adopt intervening external edits.
    const expected = new Map([...changes.keys()].map(relative => [relative, beforeNotes.find(note => note.relativePath === relative)?.revision ?? null]));
    const timestamp = now();
    for (const [relative, markdown] of changes) {
      if (!notePath(relative)) throw failure('INVALID_NOTE_PATH', 'Writes are limited to the three wiki note categories.');
      const before = beforeNotes.find(note => note.relativePath === relative);
      const after = afterMap.get(relative);
      for (const snapshot of [before, after].filter(Boolean)) {
        const historyPath = `.wiki-server/history/${sha256(relative)}/${snapshot.revision}.json`;
        if (await optionalText(this.root, historyPath) === null) {
          expected.set(historyPath, null);
          planned.set(historyPath, JSON.stringify({
            version: 1, relativePath: relative, revision: snapshot.revision, recorded_at: timestamp,
            operation: snapshot === before ? `before:${operation}` : operation, rawMarkdown: snapshot.rawMarkdown,
          }, null, 2) + '\n');
        }
      }
      planned.set(relative, markdown);
    }
    const currentIndex = await optionalText(this.root, 'wiki/index.md');
    expected.set('wiki/index.md', currentIndex === null ? null : sha256(currentIndex));
    planned.set('wiki/index.md', this.renderIndex(afterNotes, currentIndex ?? '# Wiki Index\n'));
    const oldLog = await optionalText(this.root, 'wiki/log.md');
    expected.set('wiki/log.md', oldLog === null ? null : sha256(oldLog));
    const cleanLine = value => String(value).replace(/[\r\n]/g, ' ');
    planned.set('wiki/log.md', (oldLog ?? '# Wiki Log\n') + `\n## [${timestamp}] ${cleanLine(operation)} | ${cleanLine(title)}\n`
      + [...changes.keys(), ...details].map(value => `- ${cleanLine(value)}\n`).join(''));
    for (const [relative] of changes) {
      const before = await optionalText(this.root, relative);
      if ((before === null ? null : sha256(before)) !== (beforeNotes.find(note => note.relativePath === relative)?.revision ?? null)) {
        throw failure('REVISION_CONFLICT', 'A note changed outside this MCP process while preparing the transaction.', { relativePath: relative, current_revision: before === null ? null : sha256(before) });
      }
    }
    return { ...await this.commitFiles(operation, planned, expected), changed_paths: [...changes.keys()], index_updated: true, log_appended: true };
  }
  // Internal API. Caller holds the vault lock; source registration shares this journal.
  async commitFiles(operation, planned, expected = new Map()) {
    const writes = [];
    for (const [relative, after] of planned) {
      const before = await optionalText(this.root, relative);
      if (expected.has(relative) && expected.get(relative) !== (before === null ? null : sha256(before))) throw failure('REVISION_CONFLICT', 'A vault file changed outside this MCP process while preparing the transaction.', { relativePath: relative, current_revision: before === null ? null : sha256(before) });
      if (before === after) continue;
      writes.push({ path: relative, before_revision: before === null ? null : sha256(before), after_revision: sha256(after), after });
    }
    const transaction = `.wiki-server/transactions/${randomUUID()}.json`;
    const journal = { version: 1, status: 'pending', created_at: now(), operation, writes };
    await writeJson(this.root, transaction, journal);
    try { await this.replay(transaction, journal); }
    catch (error) { throw failure('TRANSACTION_PENDING', `Transaction is retained for recovery: ${transaction}. ${error.message}`, { transaction }); }
    return { transaction };
  }
  renderIndex(notes, existing) {
    const sections = CATEGORIES.map(category => {
      const listed = notes.filter(note => note.relativePath.startsWith(`wiki/${category}/`) && note.frontmatter.archived !== true);
      return `## ${category}\n\n${listed.length ? listed.map(note => `- [[${note.title}]] — ${String(note.frontmatter.summary || note.frontmatter.scope || '').replace(/[\r\n]/g, ' ')}`).join('\n') : '_Empty._'}\n`;
    }).join('\n');
    const from = existing.indexOf(START), end = existing.indexOf(END);
    if (from >= 0 && end > from) return existing.slice(0, from + START.length) + `\n\n${sections}\n` + existing.slice(end);
    return existing.trimEnd() + `\n\n${START}\n\n${sections}\n${END}\n`;
  }
  async normalizedMetadata(frontmatter) {
    const fm = { ...frontmatter };
    fm.aliases = (fm.aliases || []).map(titleValue);
    fm.tags = fm.tags || [];
    fm.sources = [...new Set(fm.sources || [])];
    fm.review_status = fm.review_status || 'draft';
    if (!['draft', 'reviewed'].includes(fm.review_status)) throw failure('INVALID_REVIEW', 'review_status must be draft or reviewed.');
    if (fm.review_status === 'reviewed' && (!fm.sources.length || !String(fm.scope || '').trim() || !String(fm.review_note || '').trim())) {
      throw failure('REVIEW_REQUIREMENTS', 'Reviewed notes require sources, scope and a nonempty review_note. This records a review assertion, not a proof of truth.');
    }
    fm.source_references = await resolveSourceReferences(this.root, fm.sources);
    fm.verification = 'not_independently_verified';
    if (fm.provenance) fm.provenance = fm.provenance.map(item => ({ ...item, verification: 'unverified' }));
    fm.last_updated = now().slice(0, 10);
    return fm;
  }
  read(identifier) {
    return this.locked(async () => {
      const notes = await this.catalog();
      const note = resolveNote(notes, identifier);
      const backlinks = notes.flatMap(from => outgoing(from).filter(link => noteNames(note).has(key(link.target))).map(link => ({ fromFile: from.relativePath, fromTitle: from.title, linkText: link.raw })));
      return { ...note, links: outgoing(note), backlinks, archived: note.frontmatter.archived === true };
    });
  }
  write({ category, title, content, frontmatter = {}, expected_revision }) {
    return this.locked(async () => {
      title = titleValue(title);
      if (!CATEGORIES.includes(category)) throw failure('INVALID_CATEGORY', 'Unknown note category.');
      const notes = await this.catalog();
      const matching = notes.filter(note => noteNames(note).has(key(title)));
      if (matching.length > 1) throw failure('AMBIGUOUS_NOTE', 'Title matches multiple notes.');
      const existing = matching[0];
      const relative = existing?.relativePath || `wiki/${category}/${title}.md`;
      if (existing && (!relative.startsWith(`wiki/${category}/`) || existing.title !== title)) throw failure('NOTE_IDENTITY', 'Use the current title/category to edit; use wiki_rename_note to change a title.');
      if (existing) assertRevision(existing, expected_revision);
      else if (expected_revision) throw failure('REVISION_CONFLICT', 'This note does not exist; omit expected_revision when creating it.', { current_revision: null });
      const parsed = matter(content);
      const merged = { ...existing?.frontmatter, ...parsed.data, ...frontmatter, title, type: category === 'concepts' ? 'concept' : category === 'entities' ? 'entity' : 'synthesis' };
      // Archiving and review status must be explicit operations / assertions, never inferred.
      merged.archived = existing?.frontmatter.archived === true;
      merged.review_status = frontmatter.review_status || parsed.data.review_status || 'draft';
      const metadata = await this.normalizedMetadata(merged);
      const markdown = matter.stringify(parsed.content, metadata);
      const result = await this.commit(existing ? 'update' : 'create', title, new Map([[relative, markdown]]), [], notes);
      return { ...result, relativePath: relative, title, revision: sha256(markdown), review_status: metadata.review_status, verification: metadata.verification };
    });
  }
  history(identifier, revision) {
    return this.locked(async () => {
      const note = await resolveHistoricalIdentity(this.root, await this.catalog(), identifier);
      const dir = `.wiki-server/history/${sha256(note.relativePath)}`;
      if (revision) {
        const record = await readJson(this.root, `${dir}/${revision}.json`, null);
        if (!record || record.relativePath !== note.relativePath || sha256(record.rawMarkdown) !== revision) throw failure('HISTORY_NOT_FOUND', 'History revision not found, belongs to another path or is damaged.');
        return record;
      }
      let files = [];
      try { files = await readdir(await safePath(this.root, dir)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const versions = [];
      for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const { rawMarkdown, ...record } = await readJson(this.root, `${dir}/${file}`, null);
        if (record.relativePath !== note.relativePath || sha256(rawMarkdown) !== record.revision || file !== `${record.revision}.json`) throw failure('HISTORY_DAMAGED', 'History snapshot metadata does not match its path or content digest.');
        versions.push(record);
      }
      if (note.deleted && !versions.length) throw failure('HISTORY_NOT_FOUND', 'No history exists for that exact deleted-note path.');
      return { relativePath: note.relativePath, current_revision: note.revision, deleted: note.deleted === true, versions: versions.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at)) };
    });
  }
  restore({ pathOrTitle, revision, expected_revision }) {
    return this.locked(async () => {
      const notes = await this.catalog();
      const current = await resolveHistoricalIdentity(this.root, notes, pathOrTitle);
      if (current.deleted) {
        if (expected_revision !== null) throw failure('REVISION_CONFLICT', 'The note is currently missing. Pass its exact path and expected_revision: null to restore only if it remains missing.', { relativePath: current.relativePath, current_revision: null });
      } else assertRevision(current, expected_revision);
      const record = await readJson(this.root, `.wiki-server/history/${sha256(current.relativePath)}/${revision}.json`, null);
      if (!record || record.relativePath !== current.relativePath || sha256(record.rawMarkdown) !== revision) throw failure('HISTORY_NOT_FOUND', 'History revision not found, belongs to another path or is damaged.');
      const parsed = matter(record.rawMarkdown);
      const metadata = await this.normalizedMetadata(parsed.data);
      if (!current.deleted && key(metadata.title) !== key(current.title)) metadata.aliases = [...new Set([...metadata.aliases, current.title])];
      const markdown = matter.stringify(parsed.content, metadata);
      const result = await this.commit('restore', metadata.title, new Map([[current.relativePath, markdown]]), [`Restored from revision ${revision}`], notes);
      return { ...result, relativePath: current.relativePath, revision: sha256(markdown), restored_from: revision, recovered_deleted_note: current.deleted === true };
    });
  }
  rename({ pathOrTitle, new_title, expected_revision }) {
    return this.locked(async () => {
      const notes = await this.catalog();
      const current = resolveNote(notes, pathOrTitle);
      assertRevision(current, expected_revision);
      const title = titleValue(new_title);
      const changes = new Map();
      for (const note of notes) {
        const body = rewriteWikilinks(note.content, current, title);
        if (note === current || body !== note.content) {
          const fm = { ...note.frontmatter, last_updated: now().slice(0, 10) };
          if (note === current) { fm.title = title; fm.aliases = [...new Set([...current.aliases, current.title])].filter(alias => key(alias) !== key(title)); }
          changes.set(note.relativePath, matter.stringify(body, fm));
        }
      }
      const result = await this.commit('rename', `${current.title} → ${title}`, changes, ['File path remains stable; old title retained as alias.'], notes);
      return { ...result, relativePath: current.relativePath, title, revision: sha256(changes.get(current.relativePath)) };
    });
  }
  archive({ pathOrTitle, expected_revision, reason }) {
    return this.locked(async () => {
      const notes = await this.catalog();
      const note = resolveNote(notes, pathOrTitle);
      assertRevision(note, expected_revision);
      const markdown = matter.stringify(note.content, { ...note.frontmatter, archived: true, archive_reason: reason || '', archived_at: now(), last_updated: now().slice(0, 10) });
      const result = await this.commit('archive', note.title, new Map([[note.relativePath, markdown]]), ['Archived in place; use history and restore to undo.'], notes);
      return { ...result, relativePath: note.relativePath, revision: sha256(markdown), archived: true, restore_revision: note.revision };
    });
  }
  merge({ source, target, source_revision, target_revision, content, frontmatter = {} }) {
    return this.locked(async () => {
      const notes = await this.catalog();
      const from = resolveNote(notes, source), to = resolveNote(notes, target);
      if (from.relativePath === to.relativePath) throw failure('INVALID_MERGE', 'Source and target must be different notes.');
      assertRevision(from, source_revision); assertRevision(to, target_revision);
      if (from.frontmatter.archived || to.frontmatter.archived) throw failure('INVALID_MERGE', 'Restore archived notes before merging.');
      const parsed = matter(content);
      const fm = await this.normalizedMetadata({ ...to.frontmatter, ...parsed.data, ...frontmatter,
        title: to.title, type: to.type, archived: false,
        aliases: [...new Set([...to.aliases, ...(parsed.data.aliases || []), ...(frontmatter.aliases || [])])],
        tags: [...new Set([...from.tags, ...to.tags, ...(parsed.data.tags || []), ...(frontmatter.tags || [])])],
        sources: [...new Set([...from.sources, ...to.sources, ...(parsed.data.sources || []), ...(frontmatter.sources || [])])],
        review_status: frontmatter.review_status || parsed.data.review_status || 'draft',
        provenance: [...(from.frontmatter.provenance || []), ...(to.frontmatter.provenance || []), ...(parsed.data.provenance || []), ...(frontmatter.provenance || [])],
      });
      const changes = new Map();
      for (const note of notes) {
        if (note === to) changes.set(note.relativePath, matter.stringify(rewriteWikilinks(parsed.content, from, to.title), fm));
        else if (note === from) changes.set(note.relativePath, matter.stringify(`${note.content.trimEnd()}\n\nMerged into [[${to.title}]].\n`, { ...note.frontmatter, archived: true, merged_into: to.relativePath, last_updated: now().slice(0, 10) }));
        else {
          const body = rewriteWikilinks(note.content, from, to.title);
          if (body !== note.content) changes.set(note.relativePath, matter.stringify(body, { ...note.frontmatter, last_updated: now().slice(0, 10) }));
        }
      }
      const result = await this.commit('merge', `${from.title} → ${to.title}`, changes, [], notes);
      return { ...result, relativePath: to.relativePath, revision: sha256(changes.get(to.relativePath)), archived_source: from.relativePath, source_restore_revision: from.revision };
    });
  }
  rebuild() { return this.locked(async () => this.commit('rebuild_index', 'Rebuild visible-note catalog', new Map())); }
  appendLog({ operation, title, details = [] }) { return this.locked(async () => this.commit(operation, title, new Map(), details)); }
  index(include_archived = false) {
    return this.locked(async () => {
      const notes = await this.catalog();
      const existing = await optionalText(this.root, 'wiki/index.md') ?? '# Wiki Index\n';
      if (include_archived) return this.renderIndex(notes.map(note => ({ ...note, frontmatter: { ...note.frontmatter, archived: false } })), existing);
      return this.renderIndex(notes, existing);
    });
  }
  search(query, limit = 10, include_archived = false) {
    return this.locked(async () => {
      const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) throw failure('EMPTY_QUERY', 'Search query must not be empty.');
      return (await this.catalog()).filter(note => include_archived || !note.frontmatter.archived)
        .map(note => {
          const text = [note.title, ...note.aliases, ...note.tags, note.frontmatter.summary || '', note.content].join('\n').toLowerCase();
          const score = terms.every(term => text.includes(term)) ? terms.reduce((sum, term) => sum + (note.title.toLowerCase().includes(term) ? 5 : 1), 0) : 0;
          return { relativePath: note.relativePath, title: note.title, type: note.type, tags: note.tags, score, snippet: note.content.slice(0, 300), archived: note.frontmatter.archived === true, revision: note.revision };
        }).filter(note => note.score).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
    });
  }
  lint() {
    return this.locked(async () => {
      const notes = await this.catalog();
      const issues = [];
      try { assertNoAmbiguity(notes); } catch (error) { issues.push({ type: 'ambiguity', message: error.message }); }
      const linked = new Set();
      for (const note of notes.filter(value => !value.frontmatter.archived)) {
        for (const link of outgoing(note)) {
          try { const target = resolveNote(notes, link.target); linked.add(target.relativePath); linked.add(note.relativePath); }
          catch (error) { issues.push({ type: 'broken_link', path: note.relativePath, target: link.target, message: error.message }); }
        }
      }
      for (const note of notes.filter(value => !value.frontmatter.archived && !linked.has(value.relativePath))) issues.push({ type: 'orphan', path: note.relativePath });
      return { healthy: !issues.length, message: issues.length ? 'Wiki audit found issues.' : 'Wiki is completely healthy.', issues };
    });
  }
  status() {
    return this.locked(async () => {
      const notes = await this.catalog();
      const rawFiles = [];
      const walk = async relative => {
        let entries;
        try { entries = await readdir(await safePath(this.root, relative), { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of entries) { if (entry.isDirectory()) await walk(`${relative}/${entry.name}`); else if (entry.isFile()) rawFiles.push(`${relative}/${entry.name}`); }
      };
      await walk('raw');
      const references = new Set(notes.flatMap(note => [...note.sources, ...(note.frontmatter.source_references || []).map(item => item.path).filter(Boolean)]));
      const pending = rawFiles.filter(file => !references.has(file));
      return { notes: {
        total: notes.length, active: notes.filter(note => !note.frontmatter.archived).length,
        archived: notes.filter(note => note.frontmatter.archived).length,
        concepts: notes.filter(note => note.type === 'concept').length, entities: notes.filter(note => note.type === 'entity').length,
        syntheses: notes.filter(note => note.type === 'synthesis').length,
      }, sources: { totalRaw: rawFiles.length, referencedRaw: rawFiles.length - pending.length, pendingCount: pending.length, pending },
      source_accounting: 'pending means unreferenced raw files only; a citation does not establish complete compilation or independent verification.' };
    });
  }
}
