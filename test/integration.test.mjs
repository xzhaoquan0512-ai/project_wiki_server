import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWikiServer } from '../src/wiki-server.mjs';
import { createProjectServer } from '../src/project-server.mjs';
import { ProjectAdapter, relativePath, containedPath, loadProjects } from '../src/lib/project-adapter.mjs';
import { initializeVault } from '../src/vault.mjs';

async function fixture(t) {
  const base = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'llmwiki-mcp-test-'));
  t.after(async () => {
    const resolved = await realpath(root);
    if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('llmwiki-mcp-test-')) {
      throw new Error('Refusing cleanup outside the test fixture directory.');
    }
    await rm(resolved, { recursive: true });
  });
  return root;
}

async function connect(t, server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-integration-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('project paths reject traversal, absolute paths and escaping junctions', async t => {
  const base = await fixture(t);
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'not available to the project');
  for (const candidate of ['../secret', '..\\secret', '/tmp/secret', 'C:\\secret', 'C:secret', 'a/../../b']) {
    assert.throws(() => relativePath(candidate));
  }
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(containedPath(root, 'escape/secret.txt'), /outside/);
  await assert.rejects(containedPath(root, 'escape/missing/new.txt', true), /outside/);
});

test('a clean installation starts with no projects and no knowledge notes', async t => {
  const root = await fixture(t);
  const config = path.join(root, 'projects.json');
  await writeFile(config, '{"projects":[]}');
  const projects = await loadProjects(config);
  const projectClient = await connect(t, createProjectServer(projects));
  const listed = await projectClient.callTool({ name: 'project_list', arguments: {} });
  assert.deepEqual(JSON.parse(listed.content[0].text), []);
  const vault = await initializeVault(path.join(root, 'vault'));
  const wikiClient = await connect(t, await createWikiServer(vault));
  const status = JSON.parse((await wikiClient.callTool({ name: 'wiki_status', arguments: {} })).content[0].text);
  assert.equal(status.notes.total, 0);
  assert.equal(status.sources.totalRaw, 0);
  await assert.rejects(initializeVault(vault), /already exists/);
  assert.equal(await readFile(path.join(vault, 'wiki/log.md'), 'utf8'), '# Wiki Log\n\n仅记录实际发生的知识整理与维护操作。\n');
});

test('project queries serialize one session and pass query text without a shell', async t => {
  const root = await fixture(t);
  let active = 0, peak = 0;
  const calls = [];
  const runner = async (exe, args, options) => {
    active++; peak = Math.max(peak, active); calls.push({ exe, args, options });
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
    return { stdout: JSON.stringify({ status: 'passed', receipt_id: 'test' }), stderr: '' };
  };
  const adapter = new ProjectAdapter(new Map([['project', { id: 'project', root, script: path.join(root, 'backend.py'), python: 'python' }]]), runner);
  const input = { project_id: 'project', session_id: 'CTX-test', query: '--help; $(whoami)' };
  await Promise.all([adapter.call('search', input), adapter.call('search', input)]);
  assert.equal(peak, 1);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].args.includes('--query=--help; $(whoami)'));
  await assert.rejects(adapter.call('search', { ...input, project_id: 'unknown' }), /Unknown project/);
  await assert.rejects(adapter.call('search', { ...input, session_id: '../bad' }), /session_id/);
});

test('backend failures retain receipts and do not become successful queries', async t => {
  const root = await fixture(t);
  const runner = async () => { throw Object.assign(new Error('budget exceeded'), {
    code: 1, stdout: JSON.stringify({ status: 'blocked', receipt_id: 'refusal', reason: 'budget' }), stderr: '',
  }); };
  const adapter = new ProjectAdapter(new Map([['project', { id: 'project', root, script: 'backend.py', python: 'python' }]]), runner);
  const result = await adapter.call('status', { project_id: 'project', session_id: 'CTX-test' });
  assert.equal(result.exit_code, 1);
  assert.equal(result.backend.status, 'blocked');
  assert.equal(result.backend.receipt_id, 'refusal');
});

test('Git snapshot uses a fixed argv and a repository-relative evidence input', async t => {
  const root = await fixture(t);
  const runner = async (_exe, args) => {
    const file = args.find(value => value.startsWith('--argv-file=')).slice('--argv-file='.length);
    assert.ok(!path.isAbsolute(file));
    assert.ok(!file.includes('\\'));
    assert.deepEqual(JSON.parse(await readFile(path.join(root, file), 'utf8')),
      ['git', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
    return { stdout: JSON.stringify({ status: 'passed' }), stderr: '' };
  };
  const adapter = new ProjectAdapter(new Map([['project', { id: 'project', root, script: 'backend.py', python: 'python' }]]), runner);
  await adapter.call('git-status', { project_id: 'project', session_id: 'CTX-test' });
});

test('project MCP discovers only scoped query tools and refuses invalid file selectors', async t => {
  const root = await fixture(t);
  const client = await connect(t, createProjectServer(new Map([['project', { id: 'project', root, script: 'unused.py', python: 'unused' }]])));
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.equal(names.length, 8);
  assert.ok(!names.some(name => /write|shell|execute/.test(name)));
  const invalid = await client.callTool({ name: 'project_read', arguments: { project_id: 'project', session_id: 'CTX-test', path: '../outside' } });
  assert.equal(invalid.isError, true);
  const ambiguous = await client.callTool({ name: 'project_read', arguments: { project_id: 'project', session_id: 'CTX-test', path: 'x', id: 'DOC-1' } });
  assert.equal(ambiguous.isError, true);
});

test('knowledge MCP serves rules, maintains links/index/log and preserves raw source', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'wiki', 'concepts'), { recursive: true });
  await mkdir(path.join(root, 'raw'));
  await writeFile(path.join(root, 'AGENTS.md'), '# Rules\nKeep raw sources immutable.\n');
  await writeFile(path.join(root, 'raw', 'source.md'), 'immutable evidence\n');
  await writeFile(path.join(root, 'wiki', 'index.md'), '# Wiki Index\n');
  await writeFile(path.join(root, 'wiki', 'concepts', 'Seed.md'), '---\ntitle: Seed\ntype: concept\nsources: [raw/source.md]\n---\n# Seed\nRelated [[Child]].\n');
  const client = await connect(t, await createWikiServer(root));
  assert.equal((await client.listTools()).tools.length, 24);
  assert.match((await client.readResource({ uri: 'wiki://rules' })).contents[0].text, /immutable/);
  const registered = await client.callTool({ name: 'wiki_register_source', arguments: { path: 'raw/source.md' } });
  assert.notEqual(registered.isError, true);
  const write = await client.callTool({ name: 'wiki_write_note', arguments: {
    category: 'concepts', title: 'Child', content: '# Child\nSee [[Seed]].', frontmatter: { sources: ['raw/source.md'] },
  } });
  assert.notEqual(write.isError, true);
  const read = await client.callTool({ name: 'wiki_read_note', arguments: { pathOrTitle: 'Child' } });
  assert.equal(JSON.parse(read.content[0].text).backlinks[0].fromTitle, 'Seed');
  await client.callTool({ name: 'wiki_append_log', arguments: { operation: 'test', title: 'Fixture only' } });
  assert.match(await readFile(path.join(root, 'wiki', 'log.md'), 'utf8'), /Fixture only/);
  const lint = await client.callTool({ name: 'wiki_lint', arguments: {} });
  assert.match(lint.content[0].text, /completely healthy/);
  assert.equal(await readFile(path.join(root, 'raw', 'source.md'), 'utf8'), 'immutable evidence\n');
});
