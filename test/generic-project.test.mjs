import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectAdapter, loadProjects } from '../src/lib/project-adapter.mjs';
import { createProjectServer } from '../src/project-server.mjs';

const execute = promisify(execFile);

async function fixture(t) {
  const temp = await realpath(os.tmpdir());
  const base = await mkdtemp(path.join(temp, 'project-wiki-generic-'));
  const root = path.join(base, 'project');
  const stateDirectory = path.join(base, 'state');
  await mkdir(root);
  await writeFile(path.join(root, 'AGENTS.md'), '# Project rules\nKeep source evidence separate from verification.\n');
  const config = path.join(base, 'projects.json');
  await writeFile(config, JSON.stringify({ projects: [{ id: 'demo', root }] }));
  const projects = await loadProjects(config);
  const adapter = new ProjectAdapter(projects, undefined, { stateDirectory });
  t.after(async () => {
    const resolved = await realpath(base);
    if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('project-wiki-generic-')) throw new Error('Refusing unsafe fixture cleanup.');
    await rm(resolved, { recursive: true });
  });
  return { base, root, stateDirectory, config, projects, adapter };
}

async function begin(adapter, extra = {}) {
  const result = await adapter.call('begin', { project_id: 'demo', ...extra });
  assert.equal(result.backend.status, 'passed');
  return { result, scope: { project_id: 'demo', session_id: result.backend.session_id } };
}

function measured(result, max = 4000) {
  assert.equal(result.accounting.response_chars, JSON.stringify(result).length);
  assert.ok(JSON.stringify(result).length <= max);
}

test('auto adapter recognizes plain projects and preserves explicitly selected legacy backends', async t => {
  const f = await fixture(t);
  assert.equal(f.projects.get('demo').adapter, 'generic');
  await mkdir(path.join(f.root, 'tools/docs'), { recursive: true });
  await writeFile(path.join(f.root, 'tools/docs/context_session.py'), '# fixture backend');
  assert.equal((await loadProjects(f.config)).get('demo').adapter, 'context_session');
  await writeFile(f.config, JSON.stringify({ projects: [{ id: 'demo', root: f.root, adapter: 'generic' }] }));
  assert.equal((await loadProjects(f.config)).get('demo').adapter, 'generic');
  await writeFile(f.config, JSON.stringify({ projects: [{ id: 'demo', root: f.root, adapter: 'unknown' }] }));
  await assert.rejects(loadProjects(f.config), /adapter must/);
});

test('generic reads have bounded stable continuation, hashes and persistent sessions without source writes', async t => {
  const f = await fixture(t);
  const original = Array.from({ length: 200 }, (_, index) => `line ${index + 1}: "quoted" Unicode 中文 context evidence\n`).join('');
  await writeFile(path.join(f.root, 'README.md'), original);
  const before = (await readdir(f.root)).sort();
  const { result: started, scope } = await begin(f.adapter);
  assert.equal(started.backend.rules_available, true);
  measured(started);
  let result = await f.adapter.call('read', { ...scope, path: 'README.md', max_chars: 2200 });
  measured(result, 2200);
  assert.equal(result.backend.status, 'passed');
  const oldHash = result.backend.source.sha256;
  assert.deepEqual(result.backend.location.start, { line: 1, column: 1 });
  assert.ok(result.backend.next_arguments);
  await writeFile(path.join(f.root, 'README.md'), 'new live content\n');
  const restarted = new ProjectAdapter(f.projects, undefined, { stateDirectory: f.stateDirectory });
  let joined = result.backend.content;
  let pages = 0;
  while (result.backend.next_arguments) {
    result = await restarted.call('read', { ...scope, ...result.backend.next_arguments, max_chars: 2200 });
    measured(result, 2200);
    assert.equal(result.backend.source.sha256, oldHash);
    assert.match(result.backend.freshness, /historical/);
    joined += result.backend.content;
    assert.ok(++pages < 100);
  }
  assert.equal(joined, original);
  const changed = await restarted.call('read', { ...scope, path: 'README.md', expected_hash: oldHash });
  assert.equal(changed.backend.status, 'failed');
  assert.match(changed.backend.error, /differs/);
  assert.deepEqual((await readdir(f.root)).sort(), before);
  assert.equal(await readFile(path.join(f.root, 'README.md'), 'utf8'), 'new live content\n');
});

test('generic search excludes private/generated/binary paths and paginates cached results', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'docs'));
  await writeFile(path.join(f.root, 'docs/guide.md'), 'target first\ntarget second\ntarget third\n');
  for (const folder of ['.git', 'node_modules', 'build', 'data']) {
    await mkdir(path.join(f.root, folder));
    await writeFile(path.join(f.root, folder, 'hidden.md'), 'target secret');
  }
  await writeFile(path.join(f.root, '.env'), 'target SECRET=hidden');
  await writeFile(path.join(f.root, 'password.txt'), 'target hidden');
  await writeFile(path.join(f.root, 'binary.txt'), Buffer.from([116, 97, 114, 103, 101, 116, 0, 42]));
  const { scope } = await begin(f.adapter);
  const result = await f.adapter.call('search', { ...scope, query: 'TARGET', limit: 1, max_chars: 2200 });
  measured(result, 2200);
  assert.equal(result.backend.total_cached_hits, 3);
  assert.equal(result.backend.results.length, 1);
  assert.equal(result.backend.results[0].path, 'docs/guide.md');
  assert.equal(result.backend.results[0].line, 1);
  await writeFile(path.join(f.root, 'docs/guide.md'), 'nothing matches now');
  const next = await f.adapter.call('search', { ...scope, ...result.backend.next_arguments, limit: 1 });
  assert.equal(next.backend.results[0].line, 2);
  assert.match(next.backend.freshness, /historical/);
  const wiki = await f.adapter.call('search', { ...scope, query: 'target', kind: 'wiki' });
  assert.equal(wiki.backend.total_cached_hits, 0);
});

test('generic scope and selectors reject traversal, junction escapes, unsupported selector and binary data', async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'outside.md'), 'outside secret');
  await symlink(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(path.join(f.root, 'data'));
  await writeFile(path.join(f.root, 'data/cache.md'), 'generated contents');
  await symlink(path.join(f.root, 'data'), path.join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(f.root, 'binary.txt'), Buffer.from([1, 0, 3]));
  const { scope } = await begin(f.adapter);
  for (const input of [
    { path: '../outside/outside.md' }, { path: 'escape/outside.md' }, { path: 'alias/cache.md' },
    { path: 'binary.txt' }, { path: 'AGENTS.md', pointer: '/value' }, { id: 'DOC-1' },
    { path: 'AGENTS.md', limit: 1 }, { path: 'AGENTS.md', start_column: 10000 },
  ]) {
    const result = await f.adapter.call('read', { ...scope, ...input });
    assert.equal(result.backend.status, 'failed', JSON.stringify(input));
    measured(result);
  }
  const unsupported = await f.adapter.call('search', { ...scope, query: 'text', include_stale: false });
  assert.match(unsupported.backend.error, /include_stale/);
  const evidence = await f.adapter.call('evidence', { ...scope, path: 'AGENTS.md' });
  assert.match(evidence.backend.verification, /no commands, tests or verification/);
  const badState = new ProjectAdapter(f.projects, undefined, { stateDirectory: path.join(f.root, '.cache') });
  await assert.rejects(badState.call('begin', { project_id: 'demo' }), /outside every registered/);
});

test('generic budgets count complete response JSON, block exhaustion and resume without resetting history', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'README.md'), 'large evidence '.repeat(2000));
  const { result: started, scope } = await begin(f.adapter, { budget: 8000 });
  let used = started.accounting.response_chars, blocked;
  for (let index = 0; index < 15; index++) {
    const result = await f.adapter.call('read', { ...scope, path: 'README.md', max_chars: 2200 });
    measured(result, 2200);
    used += result.accounting.response_chars;
    assert.equal(result.accounting.used_chars, used);
    if (result.backend.status === 'blocked') { blocked = result; break; }
  }
  assert.ok(blocked);
  const adjusted = await f.adapter.call('adjust-budget', { ...scope, budget: 32000, reason: 'Need to finish reading the same source evidence.' });
  measured(adjusted);
  used += adjusted.accounting.response_chars;
  assert.equal(adjusted.accounting.used_chars, used);
  assert.equal(adjusted.backend.previous_budget, 8000);
  const resumed = await f.adapter.call('read', { ...scope, path: 'README.md', max_chars: 2200 });
  assert.equal(resumed.backend.status, 'passed');
  assert.equal(resumed.backend.session_id, scope.session_id);
  assert.equal(resumed.accounting.used_chars, used + resumed.accounting.response_chars);
});

test('independent adapters serialize persistent session accounting and capture fixed real Git status', async t => {
  const f = await fixture(t);
  await execute('git', ['init', '--quiet'], { cwd: f.root, windowsHide: true });
  await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', 'AGENTS.md'], { cwd: f.root, windowsHide: true });
  await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', `core.hooksPath=${path.join(f.base, 'no-hooks')}`, 'commit', '--quiet', '-m', 'fixture'], { cwd: f.root, windowsHide: true });
  const { result: started, scope } = await begin(f.adapter);
  const another = new ProjectAdapter(f.projects, undefined, { stateDirectory: f.stateDirectory });
  const responses = await Promise.all([f.adapter.call('status', scope), another.call('status', scope)]);
  const ordered = responses.sort((a, b) => a.accounting.used_chars - b.accounting.used_chars);
  assert.equal(ordered[0].accounting.used_chars, started.accounting.used_chars + ordered[0].accounting.response_chars);
  assert.equal(ordered[1].accounting.used_chars, ordered[0].accounting.used_chars + ordered[1].accounting.response_chars);
  const git = await f.adapter.call('git-status', scope);
  assert.equal(git.backend.status, 'passed');
  assert.match(git.backend.content, /# branch.oid [a-f0-9]{40}/);
  assert.match(git.backend.freshness, /not a test result/);
  measured(git);
});

test('MCP advertises generic capabilities and supports persisted scoped continuation', async t => {
  const f = await fixture(t);
  const server = createProjectServer(f.projects, { stateDirectory: f.stateDirectory });
  const client = new Client({ name: 'generic-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const listing = JSON.parse((await client.callTool({ name: 'project_list', arguments: {} })).content[0].text);
  assert.equal(listing[0].adapter, 'generic');
  assert.ok(listing[0].capabilities.unsupported_selectors.includes('pointer'));
  assert.equal((await client.listTools()).tools.length, 11);
  const started = JSON.parse((await client.callTool({ name: 'project_begin', arguments: { project_id: 'demo' } })).content[0].text);
  const response = await client.callTool({ name: 'project_read', arguments: { project_id: 'demo', session_id: started.backend.session_id, path: 'AGENTS.md', section: 'rules' } });
  assert.equal(response.isError, true);
  assert.match(JSON.parse(response.content[0].text).backend.error, /section/);
  const unknown = await client.callTool({ name: 'project_read', arguments: { project_id: 'demo', session_id: started.backend.session_id, path: 'AGENTS.md', json_pointer: '/value' } });
  assert.equal(unknown.isError, true);
});

test('generic size and hit limits are explicit, and minimum max_chars never leaks oversized JSON', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'huge.md'), 'x'.repeat(1024 * 1024 + 1));
  await writeFile(path.join(f.root, 'hits.md'), 'needle on every line\n'.repeat(510));
  const { scope } = await begin(f.adapter);
  const huge = await f.adapter.call('read', { ...scope, path: 'huge.md' });
  assert.equal(huge.backend.status, 'failed');
  assert.match(huge.backend.error, /1048576/);
  const capped = await f.adapter.call('search', { ...scope, query: 'needle', limit: 100, max_chars: 16000 });
  measured(capped, 16000);
  assert.equal(capped.backend.total_cached_hits, 500);
  assert.equal(capped.backend.scan_truncated, true);
  assert.ok(capped.backend.next_arguments);
  const tiny = await f.adapter.call('read', { ...scope, path: 'AGENTS.md', max_chars: 1000 });
  measured(tiny, 1000);
});
