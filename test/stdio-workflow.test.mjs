import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initializeVault } from '../src/vault.mjs';
import { connectLocal, callJson } from '../src/client.mjs';

async function fixture(t) {
  const base = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'wiki-workflow-test-'));
  t.after(async () => {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith('wiki-workflow-test-'));
    await rm(resolved, { recursive: true });
  });
  return root;
}

test('real stdio workflow binds sources and arbitrates competing writers across processes', async t => {
  const root = await fixture(t);
  const vault = await initializeVault(path.join(root, 'vault'));
  const first = await connectLocal('wiki', vault);
  const second = await connectLocal('wiki', vault);
  try {
    const source = await callJson(first, 'wiki_import_source', { filename: 'evidence.txt', text: 'Observed behavior for fixture revision 1.' });
    const sourceRead = await callJson(first, 'wiki_read_source', { reference: source.id });
    assert.equal(sourceRead.source.sha256, source.sha256);
    const created = await callJson(first, 'wiki_write_note', {
      category: 'concepts', title: 'Fixture', content: '# Fixture\nOriginal interpretation.',
      frontmatter: { sources: [source.id], scope: 'Fixture only', review_status: 'reviewed', review_note: 'Compared to the fixture evidence; not a general result.' },
    });
    const responses = await Promise.all([first, second].map((client, i) => client.callTool({ name: 'wiki_write_note', arguments: {
      category: 'concepts', title: 'Fixture', content: `# Fixture\nEdit ${i}.`, expected_revision: created.revision,
    } })));
    assert.equal(responses.filter(response => response.isError).length, 1);
    assert.equal(JSON.parse(responses.find(response => response.isError).content[0].text).error, 'REVISION_CONFLICT');
    const current = await callJson(first, 'wiki_read_note', { pathOrTitle: 'Fixture' });
    assert.notEqual(current.revision, created.revision);
    assert.equal(current.frontmatter.source_references[0].sha256, source.sha256);
    const history = await callJson(first, 'wiki_note_history', { pathOrTitle: 'Fixture' });
    assert.ok(history.versions.some(version => version.revision === created.revision));
    const archived = await callJson(first, 'wiki_archive_note', { pathOrTitle: 'Fixture', expected_revision: current.revision, reason: 'workflow fixture' });
    assert.deepEqual(await callJson(first, 'wiki_search', { query: 'Fixture' }), []);
    await callJson(first, 'wiki_restore_note', { pathOrTitle: 'Fixture', revision: archived.restore_revision, expected_revision: archived.revision });
    assert.equal((await callJson(first, 'wiki_read_note', { pathOrTitle: 'Fixture' })).archived, false);
    await callJson(first, 'wiki_import_source', { filename: 'evidence.txt', text: 'Observed behavior for fixture revision 2.', previous: source.id });
    const affected = await callJson(first, 'wiki_check_sources');
    assert.ok(affected.affected_notes.some(note => note.issues.some(issue => issue.issue === 'newer_version_available')));
    assert.equal(await readFile(path.join(vault, source.path), 'utf8'), 'Observed behavior for fixture revision 1.');
  } finally { await first.close(); await second.close(); }
});

test('real project stdio can query an ordinary folder without context_session.py', async t => {
  const root = await fixture(t);
  const project = path.join(root, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'AGENTS.md'), '# Rules\nFixture rules only.\n');
  await writeFile(path.join(project, 'README.md'), '# Fixture\nA portable engineering note.\n');
  const config = path.join(root, 'projects.json');
  await writeFile(config, JSON.stringify({ projects: [{ id: 'ordinary', root: project, adapter: 'generic' }] }));
  const client = await connectLocal('project', config, { env: { PROJECT_WIKI_STATE: path.join(root, 'sessions') } });
  try {
    const list = await callJson(client, 'project_list');
    assert.equal(list[0].adapter, 'generic');
    const started = await callJson(client, 'project_begin', { project_id: 'ordinary', budget: 16000 });
    const session = started.backend.session_id;
    assert.ok(session);
    const read = await callJson(client, 'project_read', { project_id: 'ordinary', session_id: session, path: 'README.md' });
    assert.ok(JSON.stringify(read).includes('portable engineering note'));
    assert.match(JSON.stringify(read), /sha256/);
  } finally { await client.close(); }
});
