import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile, readdir, unlink, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NoteStore } from '../src/lib/note-store.mjs';
import { initializeVault } from '../src/vault.mjs';
import { sha256, writeJson, atomicWrite, withVaultLock } from '../src/lib/vault-io.mjs';
import { createWikiServer } from '../src/wiki-server.mjs';

async function fixture(t) {
  const base = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'wiki-notes-test-'));
  t.after(async () => {
    const target = await realpath(root);
    if (path.dirname(target) !== base || !path.basename(target).startsWith('wiki-notes-test-')) throw new Error('Unsafe fixture cleanup.');
    await rm(target, { recursive: true });
  });
  const vault = await initializeVault(path.join(root, 'vault'));
  return { root: vault, store: new NoteStore(vault) };
}
const create = (store, title, content = `# ${title}\nBody`, frontmatter) => store.write({ category: 'concepts', title, content, frontmatter });

test('existing notes require the current revision and concurrent edits cannot both win', async t => {
  const { store, root } = await fixture(t);
  const first = await create(store, 'Alpha');
  await assert.rejects(create(store, 'Alpha', 'overwrite'), error => error.code === 'REVISION_CONFLICT' && error.current_revision === first.revision);
  const edits = await Promise.allSettled(['one', 'two'].map(content => store.write({ category: 'concepts', title: 'Alpha', content, expected_revision: first.revision })));
  assert.equal(edits.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(edits.filter(item => item.status === 'rejected')[0].reason.code, 'REVISION_CONFLICT');
  const history = await store.history('Alpha');
  assert.equal(history.versions.length, 2);
  assert.equal(sha256((await store.history('Alpha', first.revision)).rawMarkdown), first.revision);
  assert.match((await store.history('Alpha', first.revision)).rawMarkdown, /Body/);
  assert.match(await readFile(path.join(root, 'wiki/log.md'), 'utf8'), /create \| Alpha/);
});

test('rename updates wikilinks with paths/anchors/aliases while preserving code and URLs', async t => {
  const { store } = await fixture(t);
  const first = await create(store, 'Alpha', '# Alpha\nSelf [[Alpha]].', { aliases: ['A'] });
  const body = [
    '[[Alpha]] [[A#Detail|caption]] [[wiki/concepts/Alpha.md#Deep]] [[concepts/Alpha|path label]]',
    '`[[Alpha]]`', '``[[A]]``', '```md', '[[Alpha]]', '```', '~~~md', '[[Alpha]]', '~~~',
    '> ```md', '> [[Alpha]]', '> ```', '- ```md', '  [[Alpha]]', '  ```',
    '    [[Alpha]]', '<!-- [[Alpha]] -->', 'https://example.test/[[Alpha]]', '[url](https://example.test/[[Alpha]])',
  ].join('\n');
  await create(store, 'Links', body);
  const result = await store.rename({ pathOrTitle: 'Alpha', new_title: 'Beta', expected_revision: first.revision });
  assert.equal(result.relativePath, first.relativePath);
  assert.equal((await store.read('Alpha')).title, 'Beta');
  const updated = await store.read('Links');
  assert.match(updated.content, /\[\[Beta\]\] \[\[Beta#Detail\|caption\]\] \[\[Beta#Deep\]\] \[\[Beta\|path label\]\]/);
  assert.ok(updated.content.includes('`[[Alpha]]`'));
  assert.ok(updated.content.includes('~~~md\n[[Alpha]]\n~~~'));
  assert.ok(updated.content.includes('https://example.test/[[Alpha]]'));
  assert.ok(updated.content.includes('    [[Alpha]]'));
  assert.ok(updated.content.includes('> [[Alpha]]'));
  assert.ok(updated.content.includes('  [[Alpha]]'));
  assert.equal((await store.history('Links')).versions.length, 2);
  await store.restore({ pathOrTitle: 'Beta', revision: first.revision, expected_revision: result.revision });
  assert.equal((await store.read('Beta')).title, 'Alpha');
  assert.equal((await store.lint()).issues.filter(issue => issue.type === 'broken_link').length, 0);
});

test('archive preserves reads and inbound links but hides search/index, and history restores it', async t => {
  const { store, root } = await fixture(t);
  const first = await create(store, 'Alpha');
  await create(store, 'Links', '[[Alpha]]');
  const archived = await store.archive({ pathOrTitle: 'Alpha', expected_revision: first.revision, reason: 'obsolete' });
  assert.equal((await store.read('Alpha')).archived, true);
  assert.equal((await store.read('Alpha')).backlinks[0].fromTitle, 'Links');
  assert.equal((await store.search('Alpha')).some(note => note.title === 'Alpha'), false);
  assert.equal((await store.search('Alpha', 10, true)).some(note => note.title === 'Alpha'), true);
  assert.doesNotMatch(await store.index(), /\[\[Alpha\]\]/);
  assert.doesNotMatch(await readFile(path.join(root, 'wiki/index.md'), 'utf8'), /\[\[Alpha\]\]/);
  await assert.rejects(store.restore({ pathOrTitle: 'Alpha', revision: first.revision, expected_revision: first.revision }), /current note/);
  await store.restore({ pathOrTitle: 'Alpha', revision: first.revision, expected_revision: archived.revision });
  assert.equal((await store.read('Alpha')).archived, false);
});

test('merge unions sources, updates links and archives source without destroying its content', async t => {
  const { store } = await fixture(t);
  const source = await create(store, 'Alpha', 'original alpha', { sources: ['https://example.test/a'], tags: ['one'] });
  const target = await create(store, 'Beta', 'original beta', { sources: ['https://example.test/b'], tags: ['two'] });
  await create(store, 'Links', '[[Alpha#Detail|caption]]');
  await store.merge({ source: 'Alpha', target: 'Beta', source_revision: source.revision, target_revision: target.revision,
    content: '---\nsources: [https://example.test/c]\ntags: [three]\nprovenance:\n  - project_id: example\n    scope: test-only\n---\ncombined [[Alpha]]' });
  const merged = await store.read('Beta');
  assert.deepEqual(merged.sources, ['https://example.test/a', 'https://example.test/b', 'https://example.test/c']);
  assert.deepEqual(merged.tags, ['one', 'two', 'three']);
  assert.equal(merged.frontmatter.provenance[0].project_id, 'example');
  assert.equal(merged.frontmatter.provenance[0].verification, 'unverified');
  assert.equal(merged.frontmatter.review_status, 'draft');
  assert.equal((await store.read('Alpha')).archived, true);
  assert.match((await store.read('Alpha')).content, /original alpha/);
  assert.match((await store.read('Links')).content, /\[\[Beta#Detail\|caption\]\]/);
});

test('title/alias conflicts, invalid names, executable metadata and unsupported review assertions are refused', async t => {
  const { store } = await fixture(t);
  await create(store, 'Alpha', 'body', { aliases: ['A'] });
  await assert.rejects(create(store, 'Beta', 'body', { aliases: ['A'] }), error => error.code === 'AMBIGUOUS_NOTE');
  for (const title of ['', '..', 'NUL', 'bad/path', 'bad#anchor', 'bad|alias']) await assert.rejects(create(store, title));
  await assert.rejects(create(store, 'Review', 'body', { review_status: 'reviewed' }), error => error.code === 'REVIEW_REQUIREMENTS');
  await assert.rejects(create(store, 'Executable', '---js\nprocess.env.WIKI_EXECUTED = "yes"\n---\nbody'), /Executable frontmatter/);
  assert.equal(process.env.WIKI_EXECUTED, undefined);
  const reviewed = await create(store, 'Review', 'body', { review_status: 'reviewed', sources: ['https://example.test/source'], scope: 'test scope', review_note: 'Human compared the cited page.' });
  const note = await store.read('Review');
  assert.equal(note.frontmatter.verification, 'not_independently_verified');
  assert.equal(note.frontmatter.source_references[0].integrity, 'external_unchecked');
  await store.write({ category: 'concepts', title: 'Review', content: 'new body', expected_revision: reviewed.revision });
  assert.equal((await store.read('Review')).frontmatter.review_status, 'draft');
});

test('pending multi-file transactions recover idempotently before reads', async t => {
  const { store, root } = await fixture(t);
  const first = await create(store, 'Alpha');
  const before = (await store.read('Alpha')).rawMarkdown;
  const after = before.replace('Body', 'Recovered body');
  const oldLog = await readFile(path.join(root, 'wiki/log.md'), 'utf8');
  const newLog = oldLog + '\nRecovered transaction once.\n';
  const transaction = `.wiki-server/transactions/${randomUUID()}.json`;
  await withVaultLock(root, async () => {
    await writeJson(root, transaction, { version: 1, status: 'pending', operation: 'test-crash', writes: [
      { path: first.relativePath, before_revision: sha256(before), after_revision: sha256(after), after },
      { path: 'wiki/log.md', before_revision: sha256(oldLog), after_revision: sha256(newLog), after: newLog },
    ] });
    // Simulate a crash after the first output has been committed.
    await atomicWrite(root, first.relativePath, after);
  });
  assert.match((await store.read('Alpha')).content, /Recovered body/);
  assert.equal(await readFile(path.join(root, 'wiki/log.md'), 'utf8'), newLog);
  await store.read('Alpha');
  assert.equal(await readFile(path.join(root, 'wiki/log.md'), 'utf8'), newLog);
  assert.equal(JSON.parse(await readFile(path.join(root, transaction), 'utf8')).status, 'committed');
});

test('pending transactions refuse external modifications instead of silently overwriting', async t => {
  const { store, root } = await fixture(t);
  const first = await create(store, 'Alpha');
  const before = (await store.read('Alpha')).rawMarkdown;
  const after = before.replace('Body', 'pending change');
  await writeJson(root, `.wiki-server/transactions/${randomUUID()}.json`, { version: 1, status: 'pending', writes: [
    { path: first.relativePath, before_revision: sha256(before), after_revision: sha256(after), after },
  ] });
  const outsideEdit = before + '\nManual edit\n';
  await writeFile(path.join(root, first.relativePath), outsideEdit);
  await assert.rejects(store.read('Alpha'), error => error.code === 'TRANSACTION_BLOCKED');
  assert.equal(await readFile(path.join(root, first.relativePath), 'utf8'), outsideEdit);
});

test('MCP reports revision conflicts as errors containing the current revision', async t => {
  const { root } = await fixture(t);
  const server = await createWikiServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'notes-test', version: '1' });
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const first = await client.callTool({ name: 'wiki_write_note', arguments: { category: 'concepts', title: 'Alpha', content: 'body' } });
  assert.notEqual(first.isError, true);
  const conflict = await client.callTool({ name: 'wiki_write_note', arguments: { category: 'concepts', title: 'Alpha', content: 'overwrite' } });
  assert.equal(conflict.isError, true);
  assert.equal(JSON.parse(conflict.content[0].text).current_revision, JSON.parse(first.content[0].text).revision);
  const log = await readFile(path.join(root, 'wiki/log.md'), 'utf8');
  assert.equal((log.match(/create \| Alpha/g) || []).length, 1);
  assert.ok((await readdir(path.join(root, '.wiki-server/transactions'))).length);
});

test('deleted-note history and restore require its exact original path and null current revision', async t => {
  const { store, root } = await fixture(t);
  const original = await create(store, 'Deleted', 'Saved body.');
  await unlink(path.join(root, original.relativePath));
  await assert.rejects(store.history('Deleted'), /original exact/);
  const history = await store.history(original.relativePath);
  assert.equal(history.deleted, true);
  assert.equal(history.current_revision, null);
  assert.equal(history.versions[0].revision, original.revision);
  await assert.rejects(store.restore({ pathOrTitle: original.relativePath, revision: original.revision, expected_revision: original.revision }), error => error.code === 'REVISION_CONFLICT' && error.current_revision === null);
  const restored = await store.restore({ pathOrTitle: original.relativePath, revision: original.revision, expected_revision: null });
  assert.equal(restored.recovered_deleted_note, true);
  assert.match((await store.read('Deleted')).content, /Saved body/);
  assert.match(await readFile(path.join(root, 'wiki/index.md'), 'utf8'), /\[\[Deleted\]\]/);
});

test('deleted-note restore cannot overwrite a file recreated after history was inspected', async t => {
  const { store, root } = await fixture(t);
  const original = await create(store, 'Deleted', 'Saved body.');
  await unlink(path.join(root, original.relativePath));
  await store.history(original.relativePath);
  const recreated = '---\ntitle: Deleted\ntype: concept\n---\nReplacement written outside MCP.\n';
  await writeFile(path.join(root, original.relativePath), recreated);
  await assert.rejects(store.restore({ pathOrTitle: original.relativePath, revision: original.revision, expected_revision: null }), error => error.code === 'REVISION_CONFLICT' && error.current_revision === sha256(recreated));
  assert.equal(await readFile(path.join(root, original.relativePath), 'utf8'), recreated);
});

test('note commits preserve external index/log appends occurring after outputs were prepared', async t => {
  const { store, root } = await fixture(t);
  const original = await create(store, 'Alpha', 'Original body.');
  const beforeNote = (await store.read('Alpha')).rawMarkdown;
  const commit = store.commitFiles.bind(store);
  for (const relative of ['wiki/log.md', 'wiki/index.md']) {
    const marker = `\nEXTERNAL APPEND TO ${relative}\n`;
    store.commitFiles = async (operation, files, expected) => {
      await appendFile(path.join(root, relative), marker);
      return commit(operation, files, expected);
    };
    await assert.rejects(store.write({ category: 'concepts', title: 'Alpha', content: 'New body.', expected_revision: original.revision }),
      error => error.code === 'REVISION_CONFLICT' && error.relativePath === relative);
    store.commitFiles = commit;
    assert.ok((await readFile(path.join(root, relative), 'utf8')).includes(marker));
    assert.equal((await store.read('Alpha')).rawMarkdown, beforeNote);
  }
});
