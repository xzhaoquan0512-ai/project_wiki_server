import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeVault } from '../src/vault.mjs';
import { connectLocal, callJson } from '../src/client.mjs';
import { ProjectAdapter } from '../src/lib/project-adapter.mjs';
import { createExtractionQueue } from '../src/lib/extractors/queue.mjs';

// Concurrency guarantees, all of them observable from outside the service:
//   - writers in separate processes serialize on the vault lock and lose nothing
//   - one revision can only be consumed once, even when two writers race
//   - the project adapter serializes one session and runs separate sessions in parallel
//   - a held writer lock fails note operations after its deadline, while source reads continue
//   - the extraction queue bounds how much pending parsing one process accepts
//
// Timing is observed through the calls themselves (which intervals overlap) rather than
// through wall-clock thresholds, so a loaded machine does not turn these into flakes.

async function fixture(t) {
  const base = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'wiki-concurrency-test-'));
  t.after(async () => {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith('wiki-concurrency-test-'));
    await rm(resolved, { recursive: true });
  });
  return root;
}

// A separate process writing one note, so the vault lock really is exercised across processes.
const WRITER = `const [clientUrl, vault, title] = process.argv.slice(2);
const { connectLocal, callJson } = await import(clientUrl);
const client = await connectLocal('wiki', vault);
try {
  const created = await callJson(client, 'wiki_write_note', {
    category: 'concepts', title, content: '# ' + title + '\\nWritten by a separate process.',
  });
  console.log(JSON.stringify({ ok: true, revision: created.revision }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error.message).slice(0, 300) }));
} finally { await client.close(); }
`;

function runWriter(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', () => {
      try { resolve(JSON.parse(stdout.trim().split('\n').pop())); }
      catch { resolve({ ok: false, error: `unparseable output: ${stdout.slice(-160)} ${stderr.slice(-160)}` }); }
    });
  });
}

test('writers in separate processes serialize on one vault and lose no update', async t => {
  const root = await fixture(t);
  const vault = await initializeVault(path.join(root, 'vault'));
  const script = path.join(root, 'writer.mjs');
  await writeFile(script, WRITER);
  const clientUrl = new URL('../src/client.mjs', import.meta.url).href;
  const titles = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];

  const results = await Promise.all(titles.map(title => runWriter(script, [clientUrl, vault, title])));
  assert.deepEqual(results.filter(result => !result.ok), [], 'every concurrent writer must land');

  const client = await connectLocal('wiki', vault);
  try {
    const status = await callJson(client, 'wiki_status');
    assert.equal(status.notes.total, titles.length);
    const index = await client.callTool({ name: 'wiki_read_index', arguments: {} });
    const text = index.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    for (const title of titles) assert.ok(text.includes(title), `${title} is missing from the regenerated index`);
  } finally { await client.close(); }
});

test('one note revision can only be consumed once when two writers race', async t => {
  const root = await fixture(t);
  const vault = await initializeVault(path.join(root, 'vault'));
  const client = await connectLocal('wiki', vault);
  try {
    const created = await callJson(client, 'wiki_write_note', { category: 'concepts', title: 'Race', content: '# Race\nOriginal.' });
    const write = body => callJson(client, 'wiki_write_note', {
      category: 'concepts', title: 'Race', content: `# Race\n${body}`, expected_revision: created.revision,
    });
    const settled = await Promise.allSettled([write('Writer one.'), write('Writer two.')]);
    assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
    const rejected = settled.filter(item => item.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /REVISION_CONFLICT/);
    const current = await callJson(client, 'wiki_read_note', { pathOrTitle: 'Race' });
    assert.ok(/Writer one\.|Writer two\./.test(current.content), 'the surviving body must be one complete writer');
  } finally { await client.close(); }
});

test('the project adapter serializes one session and parallelizes separate sessions', async t => {
  const root = await fixture(t);
  const intervals = [];
  const runner = async (_executable, args) => {
    const session = args.find(value => value.startsWith('--session=')).slice('--session='.length);
    const entered = Date.now();
    await new Promise(resolve => setTimeout(resolve, 120));
    const left = Date.now();
    intervals.push({ session, entered, left });
    return { stdout: JSON.stringify({ status: 'passed', session }), stderr: '' };
  };
  const adapter = new ProjectAdapter(new Map([['demo', { id: 'demo', root, adapter: 'context_session', script: 'backend.py', python: 'python' }]]), runner);
  const overlapping = (a, b) => a.entered < b.left && b.entered < a.left;

  const scope = session_id => ({ project_id: 'demo', session_id });
  await Promise.all([1, 2, 3].map(() => adapter.call('status', scope('CTX-one'))));
  const oneSession = intervals.filter(item => item.session === 'CTX-one');
  assert.equal(oneSession.length, 3);
  for (const first of oneSession) {
    for (const second of oneSession) {
      if (first !== second) assert.ok(!overlapping(first, second), 'two calls on one session reached the backend at the same time');
    }
  }

  intervals.length = 0;
  await Promise.all(['CTX-a', 'CTX-b', 'CTX-c'].map(id => adapter.call('status', scope(id))));
  assert.equal(intervals.length, 3);
  const pairs = intervals.flatMap((first, index) => intervals.slice(index + 1).map(second => overlapping(first, second)));
  assert.ok(pairs.some(Boolean), 'separate sessions must be able to run at the same time');
});

test('a held writer lock stops note operations at its deadline while source reads continue', async t => {
  const root = await fixture(t);
  const vault = await initializeVault(path.join(root, 'vault'));
  const client = await connectLocal('wiki', vault);
  try {
    const imported = await callJson(client, 'wiki_import_source', { filename: 'evidence.txt', text: 'Source text that exists before the lock is taken.\n'.repeat(4) });
    const lock = path.join(vault, '.wiki-server/write.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({
      token: 'foreign', pid: 999999, hostname: 'elsewhere', started_at: new Date().toISOString(),
    }));

    const started = Date.now();
    await assert.rejects(callJson(client, 'wiki_read_note', { pathOrTitle: 'anything' }), /VAULT_LOCKED/);
    const waited = Date.now() - started;
    // The acquisition deadline is 8 s: a foreign lock must fail loudly rather than wait forever.
    assert.ok(waited >= 6000, `a held lock should be reported after its deadline, not after ${waited} ms`);

    // Reading extracted source material does not take the writer lock, so a held lock must
    // not stop it; that is what keeps a long note operation from blocking OCR and PDF reads.
    const source = await callJson(client, 'wiki_read_source', { reference: imported.id });
    assert.equal(source.source.sha256, imported.sha256);
  } finally { await client.close(); }
});

test('the extraction queue bounds pending work and cancels waits past its deadline', async t => {
  const root = await fixture(t);
  const enqueue = createExtractionQueue();
  const slow = () => new Promise(resolve => setTimeout(() => resolve('parsed'), 60));
  const settled = await Promise.allSettled(Array.from({ length: 10 }, () => enqueue(slow)));
  const fulfilled = settled.filter(item => item.status === 'fulfilled');
  const rejected = settled.filter(item => item.status === 'rejected');
  assert.equal(fulfilled.length, 8, 'the default pending limit is 8');
  assert.equal(rejected.length, 2);
  for (const item of rejected) assert.match(item.reason.message, /queue is full/);

  const shortQueue = createExtractionQueue({ wait_ms: 30 });
  const waiting = () => new Promise(resolve => setTimeout(() => resolve('parsed'), 200));
  const pair = await Promise.allSettled([shortQueue(waiting), shortQueue(waiting)]);
  assert.equal(pair[0].status, 'fulfilled');
  assert.match(pair[1].reason.message, /wait exceeded/);
});
