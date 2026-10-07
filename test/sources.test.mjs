import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SourceStore, resolveSourceReferences, registerSourceTools } from '../src/lib/source-store.mjs';
import { initializeVault } from '../src/vault.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { connectLocal, callJson } from '../src/client.mjs';

async function fixture(t) {
  const parent = await realpath(os.tmpdir());
  const temporary = await mkdtemp(path.join(parent, 'wiki-sources-test-'));
  t.after(async () => {
    const resolved = await realpath(temporary);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('wiki-sources-test-')) throw new Error('Unsafe fixture cleanup.');
    await rm(resolved, { recursive: true });
  });
  const root = await initializeVault(path.join(temporary, 'vault'));
  return { root, temporary, store: new SourceStore(root) };
}

function tinyPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...['First page evidence', 'Second page evidence'].map(text => {
      const stream = `BT /F1 12 Tf 20 350 Td (${text}) Tj ET`;
      return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    }),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('source imports deduplicate and create immutable versions for repeated filenames', async t => {
  const { root, store } = await fixture(t);
  const first = await store.importSource({ filename: 'guide.md', text: 'Original source' });
  const duplicate = await store.importSource({ filename: 'another.md', text: 'Original source' });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.path, first.path);
  assert.equal(duplicate.deduplicated, true);
  const updated = await store.importSource({ filename: 'guide.md', text: 'Revised source', previous: first.id });
  assert.notEqual(updated.path, first.path);
  assert.equal(updated.previous, first.id);
  assert.equal(await readFile(path.join(root, first.path), 'utf8'), 'Original source');
  assert.equal(await readFile(path.join(root, updated.path), 'utf8'), 'Revised source');
  const manifest = JSON.parse(await readFile(path.join(root, '.wiki-server/sources.json'), 'utf8'));
  assert.equal(manifest.sources.length, 2);
  const log = await readFile(path.join(root, 'wiki/log.md'), 'utf8');
  assert.equal((log.match(/import-source:/g) || []).length, 2);
});

test('source paths cannot escape raw or use linked directories and originals cannot be re-registered after alteration', async t => {
  const { root, temporary, store } = await fixture(t);
  for (const relative of ['wiki/log.md', 'raw/../AGENTS.md', 'raw\\secret.txt', '/raw/a', 'raw/C:a', 'raw/a/../../b']) {
    await assert.rejects(store.registerSource({ path: relative }), /raw|safe|path/i);
  }
  for (const filename of ['../secret', 'C:secret', 'nul.txt', 'raw/file.md']) {
    await assert.rejects(store.importSource({ filename, text: 'bad' }), /filename/);
  }
  await mkdir(path.join(temporary, 'outside'));
  await writeFile(path.join(temporary, 'outside/secret.txt'), 'outside');
  await symlink(path.join(temporary, 'outside'), path.join(root, 'raw/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.registerSource({ path: 'raw/link/secret.txt' }), /link/i);
  const first = await store.importSource({ filename: 'original.txt', text: 'original' });
  await writeFile(path.join(root, first.path), 'changed outside MCP');
  await assert.rejects(store.registerSource({ path: first.path }), /changed/);
  await assert.rejects(resolveSourceReferences(root, [first.path]), /changed/);
});

test('registered and unregistered sources paginate; source resolutions bind current immutable versions', async t => {
  const { root, store } = await fixture(t);
  await writeFile(path.join(root, 'raw/external.md'), 'Already on disk');
  const source = await store.importSource({ filename: 'imported.md', text: 'Imported' });
  const firstPage = await store.listSources({ limit: 1 });
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.next_offset, 1);
  assert.equal(firstPage.entries[0].registered, false);
  await assert.rejects(resolveSourceReferences(root, ['raw/external.md']), /Unregistered/);
  const registration = await store.registerSource({ path: 'raw/external.md' });
  assert.equal(registration.deduplicated, false);
  const resolved = await resolveSourceReferences(root, [source.id, registration.path, 'https://example.invalid/article', 'npm:some-package']);
  assert.equal(resolved[0].sha256, source.sha256);
  assert.equal(resolved[0].integrity, 'ok');
  assert.equal(resolved[1].path, 'raw/external.md');
  assert.equal(resolved[2].integrity, 'external_unchecked');
  assert.equal(resolved[3].integrity, 'external_unchecked');
});

test('source text supports line start and lossless character continuation', async t => {
  const { store } = await fixture(t);
  const text = 'first line\nsecond line🙂\nlast line';
  const source = await store.importSource({ filename: 'text.txt', text });
  const second = await store.readSource({ reference: source.id, start_line: 2, max_chars: 11 });
  assert.equal(second.start_line, 2);
  assert.equal(second.text, 'second line');
  const continuation = await store.readSource({ reference: source.id, offset: second.next_offset });
  assert.equal(second.text + continuation.text, text.slice(text.indexOf('\n') + 1));
  assert.equal(continuation.next_offset, null);
  await assert.rejects(store.readSource({ reference: source.id, start_line: 2, offset: 4 }), /not both/);
  await assert.rejects(store.readSource({ reference: source.id, start_line: 100 }), /exceeds/);
});

test('PDF source extracts real page text with explicit page numbers and continuation', async t => {
  const { store } = await fixture(t);
  const source = await store.importSource({ filename: 'reference.pdf', base64: tinyPdf().toString('base64') });
  const result = await store.readSource({ reference: source.id, ocr: 'off', page: 2 });
  assert.equal(result.format, 'pdf_text');
  assert.equal(result.page_count, 2);
  assert.equal(result.pages[0].page, 2);
  assert.match(result.pages[0].text, /Second page evidence/);
  assert.equal(result.ocr_available, true);
  assert.equal(result.next, null);
  const first = await store.readSource({ reference: source.id, ocr: 'off', page: 1, max_chars: 6 });
  assert.equal(first.pages[0].text, 'First ');
  const rest = await store.readSource({ reference: source.id, ocr: 'off', ...first.next });
  assert.equal(first.pages[0].text + rest.pages[0].text, 'First page evidence');
  assert.deepEqual(rest.next, { page: 2, page_offset: 0 });
});

test('source checks report source changes, missing originals, newer versions and affected notes without claiming compilation', async t => {
  const { root, store } = await fixture(t);
  const original = await store.importSource({ filename: 'evidence.md', text: 'original' });
  const next = await store.importSource({ filename: 'evidence.md', text: 'updated', previous: original.id });
  const refs = await resolveSourceReferences(root, [original.path]);
  await writeFile(path.join(root, 'wiki/concepts/finding.md'), `---\ntitle: Finding\nsources: [${JSON.stringify(original.path)}]\nsource_references: ${JSON.stringify(refs)}\n---\nFinding body\n`);
  let check = await store.checkSources();
  assert.equal(check.affected_notes[0].issues[0].issue, 'newer_version_available');
  assert.ok(check.affected_notes[0].issues[0].newer_versions.includes(next.id));
  await writeFile(path.join(root, original.path), 'unexpected alteration');
  check = await store.checkSources();
  assert.ok(check.affected_notes[0].issues.some(item => item.issue === 'changed'));
  assert.ok(check.affected_notes[0].issues.some(item => item.issue === 'note_source_version_mismatch'));
  assert.match(check.compilation_status, /not complete compilation/);
  assert.equal(check.has_source_problems, true);
  await rm(path.join(root, next.path));
  check = await store.checkSources();
  assert.ok(check.sources.some(item => item.id === next.id && item.integrity === 'missing'));
});

test('source MCP tools expose bounded inputs and surface integrity errors', async t => {
  const { root } = await fixture(t);
  const server = new McpServer({ name: 'source-test', version: '1.0.0' });
  registerSourceTools(server, root);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'source-test-client', version: '1.0.0' });
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  assert.equal((await client.listTools()).tools.length, 5);
  const bad = await client.callTool({ name: 'wiki_import_source', arguments: { filename: 'a.txt', text: 'a', base64: 'YQ==' } });
  assert.equal(bad.isError, true);
  const imported = await client.callTool({ name: 'wiki_import_source', arguments: { filename: 'a.txt', text: 'Source content' } });
  const item = JSON.parse(imported.content[0].text);
  const sourceRead = await client.callTool({ name: 'wiki_read_source', arguments: { reference: item.id } });
  assert.equal(JSON.parse(sourceRead.content[0].text).text, 'Source content');
  const absent = await client.callTool({ name: 'wiki_read_source', arguments: { reference: 'raw/missing.txt' } });
  assert.equal(absent.isError, true);
});

test('partial source registration replays the shared journal before deduplication and preserves a single audit', async t => {
  const { root, store } = await fixture(t);
  const { NoteStore } = await import('../src/lib/note-store.mjs');
  const { atomicWrite } = await import('../src/lib/vault-io.mjs');
  const journal = new NoteStore(root);
  journal.replay = async (_relative, transaction) => {
    await atomicWrite(root, transaction.writes[0].path, transaction.writes[0].after);
    throw new Error('Injected process interruption after registry write');
  };
  const interrupted = new SourceStore(root, { commitFiles: (operation, files, expected) => journal.commitFiles(operation, files, expected) });
  await assert.rejects(interrupted.importSource({ filename: 'recover.md', text: 'kept original' }), /did not finish.*Original may already exist/s);
  assert.equal(await readFile(path.join(root, 'raw/recover.md'), 'utf8'), 'kept original');
  const recovered = await store.importSource({ filename: 'recover.md', text: 'kept original' });
  assert.equal(recovered.deduplicated, true);
  const log = await readFile(path.join(root, 'wiki/log.md'), 'utf8');
  assert.equal((log.match(/import-source:/g) || []).length, 1);
});

test('failure before the source registry transaction leaves a discoverable original that can be registered', async t => {
  const { root, store } = await fixture(t);
  const interrupted = new SourceStore(root, { commitFiles: async () => { throw new Error('Injected registry transaction failure'); } });
  await assert.rejects(interrupted.importSource({ filename: 'recover.txt', text: 'original bytes' }), /wiki_register_source/);
  const listed = await store.listSources();
  assert.equal(listed.entries[0].path, 'raw/recover.txt');
  assert.equal(listed.entries[0].registered, false);
  await store.registerSource({ path: 'raw/recover.txt' });
  assert.equal((await resolveSourceReferences(root, ['raw/recover.txt']))[0].integrity, 'ok');
});

test('source scans do not execute JavaScript frontmatter and concurrent imports preserve all registrations', async t => {
  const { root, store } = await fixture(t);
  await writeFile(path.join(root, 'wiki/concepts/unsafe.md'), '---js\n({title: (globalThis.__unsafe_source_frontmatter = true)})\n---\nUntrusted note\n');
  const imported = await Promise.all(['A', 'B', 'C'].map(text => store.importSource({ filename: 'same.txt', text })));
  assert.equal(new Set(imported.map(item => item.path)).size, 3);
  const checked = await store.checkSources();
  assert.equal(checked.sources.length, 3);
  assert.ok(checked.scan_issues.some(item => item.path.endsWith('unsafe.md')));
  assert.equal(globalThis.__unsafe_source_frontmatter, undefined);
});

test('PDF extraction stays valid over the real stdio MCP transport', async t => {
  const { root } = await fixture(t);
  const client = await connectLocal('wiki', root);
  t.after(async () => { await client.close(); });
  const errors = [];
  client.onerror = error => { errors.push(error.message); };
  const source = await callJson(client, 'wiki_import_source', { filename: 'stdio.pdf', base64: tinyPdf().toString('base64') });
  const read = await callJson(client, 'wiki_read_source', { reference: source.id, page: 2 });
  assert.equal(read.pages[0].page, 2);
  assert.match(read.pages[0].text, /Second page evidence/);
  assert.equal((await callJson(client, 'wiki_list_sources')).total, 1);
  assert.deepEqual(errors, []);
});

test('duplicate imports validate and record missing version relationships without changing originals', async t => {
  const { root, store } = await fixture(t);
  const first = await store.importSource({ filename: 'version-a.txt', text: 'version A' });
  const second = await store.importSource({ filename: 'version-b.txt', text: 'version B' });
  const alternative = await store.importSource({ filename: 'version-c.txt', text: 'version C' });
  await assert.rejects(store.importSource({ filename: 'version-b.txt', text: 'version B', previous: 'raw/missing.txt' }), /Unregistered source/);
  const linked = await store.importSource({ filename: 'ignored-name.txt', text: 'version B', previous: first.id });
  assert.equal(linked.deduplicated, true);
  assert.equal(linked.path, second.path);
  assert.equal(linked.previous, first.id);
  assert.equal(await readFile(path.join(root, second.path), 'utf8'), 'version B');
  let checked = await store.checkSources();
  assert.ok(checked.sources.find(item => item.id === first.id).superseded_by.includes(second.id));
  await store.importSource({ filename: 'version-b.txt', text: 'version B', previous: first.path });
  assert.equal((await readFile(path.join(root, 'wiki/log.md'), 'utf8')).match(/link-source-version:/g).length, 1);
  await assert.rejects(store.importSource({ filename: 'version-b.txt', text: 'version B', previous: alternative.id }), /different previous/);
  await assert.rejects(store.importSource({ filename: 'version-b.txt', text: 'version B', previous: second.id }), /themselves|cycle/);
  await assert.rejects(store.importSource({ filename: 'version-a.txt', text: 'version A', previous: second.id }), /themselves|cycle/);
  checked = await store.checkSources();
  assert.equal(checked.sources.find(item => item.id === second.id).previous, first.id);
  assert.equal(checked.sources.find(item => item.id === first.id).previous, undefined);
});

test('duplicate registrations link versions once and reject invalid, conflicting and cyclic predecessors', async t => {
  const { root, store } = await fixture(t);
  const first = await store.importSource({ filename: 'registered-a.txt', text: 'Registered A' });
  const second = await store.importSource({ filename: 'registered-b.txt', text: 'Registered B' });
  const other = await store.importSource({ filename: 'registered-c.txt', text: 'Registered C' });
  await assert.rejects(store.registerSource({ path: second.path, previous: 'raw/absent.txt' }), /Unregistered source/);
  const linked = await store.registerSource({ path: second.path, previous: first.id });
  assert.equal(linked.previous, first.id);
  assert.equal(linked.deduplicated, true);
  await store.registerSource({ path: second.path, previous: first.path });
  await assert.rejects(store.registerSource({ path: second.path, previous: other.id }), /different previous/);
  await assert.rejects(store.registerSource({ path: second.path, previous: second.id }), /themselves|cycle/);
  await assert.rejects(store.registerSource({ path: first.path, previous: second.id }), /themselves|cycle/);
  await writeFile(path.join(root, 'raw/registered-copy.txt'), 'Registered B');
  await assert.rejects(store.registerSource({ path: 'raw/registered-copy.txt', previous: other.id }), /different previous/);
  assert.equal((await store.listSources()).entries.find(item => item.path === 'raw/registered-copy.txt').registered, false);
  const alias = await store.registerSource({ path: 'raw/registered-copy.txt', previous: first.id });
  assert.ok(alias.paths.includes('raw/registered-copy.txt'));
  assert.equal(alias.previous, first.id);
  assert.equal((await readFile(path.join(root, 'wiki/log.md'), 'utf8')).match(/link-source-version:/g).length, 1);
});

test('source readers reject selectors for the wrong format instead of silently ignoring them', async t => {
  const { store } = await fixture(t);
  const text = await store.importSource({ filename: 'selectors.txt', text: 'first\nsecond\n' });
  const pdf = await store.importSource({ filename: 'selectors.pdf', base64: tinyPdf().toString('base64') });
  for (const selectors of [{ page: 2 }, { page_count: 2 }, { page_offset: 1 }]) {
    await assert.rejects(store.readSource({ reference: text.id, ...selectors }), /not applicable/);
  }
  for (const selectors of [{ start_line: 1 }, { offset: 1 }]) {
    await assert.rejects(store.readSource({ reference: pdf.id, ...selectors }), /not applicable/);
  }
  assert.equal((await store.readSource({ reference: text.id, page: 1, page_count: 1, page_offset: 0 })).text, 'first\nsecond\n');
  assert.equal((await store.readSource({ reference: pdf.id, offset: 0, page: 2 })).pages[0].page, 2);
});

test('source registration uses the original log revision and preserves an external append before commit', async t => {
  const { root, store } = await fixture(t);
  const { NoteStore } = await import('../src/lib/note-store.mjs');
  const { sha256 } = await import('../src/lib/vault-io.mjs');
  const logPath = path.join(root, 'wiki/log.md');
  const beforeLog = await readFile(logPath, 'utf8');
  const external = '\nExternal audit appended after SourceStore read.\n';
  const journal = new NoteStore(root);
  const racing = new SourceStore(root, { commitFiles: async (operation, files, expected) => {
    assert.equal(expected.get('wiki/log.md'), sha256(beforeLog));
    assert.equal(expected.get('.wiki-server/sources.json'), null);
    await appendFile(logPath, external);
    return journal.commitFiles(operation, files, expected);
  } });
  await assert.rejects(racing.importSource({ filename: 'race-log.txt', text: 'Retained original' }), /did not finish.*changed outside/s);
  assert.equal(await readFile(logPath, 'utf8'), beforeLog + external);
  await assert.rejects(readFile(path.join(root, '.wiki-server/sources.json')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'raw/race-log.txt'), 'utf8'), 'Retained original');
  await store.registerSource({ path: 'raw/race-log.txt' });
  assert.ok((await readFile(logPath, 'utf8')).includes(external.trim()));
  assert.equal((await store.listSources()).entries[0].registered, true);
});

test('source registration uses the original registry revision and preserves an external registry change', async t => {
  const { root, store } = await fixture(t);
  await store.importSource({ filename: 'seed.txt', text: 'Known source' });
  const { NoteStore } = await import('../src/lib/note-store.mjs');
  const { sha256 } = await import('../src/lib/vault-io.mjs');
  const registryPath = path.join(root, '.wiki-server/sources.json');
  const original = await readFile(registryPath);
  const beforeLog = await readFile(path.join(root, 'wiki/log.md'), 'utf8');
  const external = { ...JSON.parse(original.toString('utf8')), manual_revision: 'preserve this edit' };
  const externalJson = JSON.stringify(external, null, 2) + '\n';
  const journal = new NoteStore(root);
  const racing = new SourceStore(root, { commitFiles: async (operation, files, expected) => {
    assert.equal(expected.get('.wiki-server/sources.json'), sha256(original));
    await writeFile(registryPath, externalJson);
    return journal.commitFiles(operation, files, expected);
  } });
  await assert.rejects(racing.importSource({ filename: 'race-registry.txt', text: 'New evidence' }), /did not finish.*changed outside/s);
  assert.equal(await readFile(registryPath, 'utf8'), externalJson);
  assert.equal(await readFile(path.join(root, 'wiki/log.md'), 'utf8'), beforeLog);
  await store.registerSource({ path: 'raw/race-registry.txt' });
  const recovered = JSON.parse(await readFile(registryPath, 'utf8'));
  assert.equal(recovered.manual_revision, 'preserve this edit');
  assert.equal(recovered.sources.length, 2);
});
