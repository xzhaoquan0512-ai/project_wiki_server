import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { initializeVault } from '../src/vault.mjs';
import { NoteStore } from '../src/lib/note-store.mjs';
import { SourceStore } from '../src/lib/source-store.mjs';
import { startPanel, isLoopback } from '../src/panel-server.mjs';

let base, vault, panel, updatedRevision;

async function call(pathname, options = {}) {
  const response = await fetch(`${panel.url.replace(/\/$/, '')}${pathname}`, options);
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, headers: response.headers, body };
}

const post = (pathname, payload) => call(pathname, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

// fetch() forbids setting Origin, so the cross-origin case needs a raw request.
function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest({
      hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

const note = pathname => `/api/note?pathOrTitle=${encodeURIComponent(pathname)}`;

before(async () => {
  const parent = await realpath(os.tmpdir());
  base = await mkdtemp(path.join(parent, 'project-wiki-panel-test-'));
  vault = path.join(base, 'vault');
  await initializeVault(vault);
  const notes = new NoteStore(vault);
  const created = await notes.write({
    category: 'concepts', title: '面板测试概念',
    content: '# 面板测试概念\n\n第一版正文。\n',
    frontmatter: { summary: '面板测试摘要', tags: ['测试'] },
  });
  updatedRevision = (await notes.write({
    category: 'concepts', title: '面板测试概念',
    content: '# 面板测试概念\n\n第二版正文，正文里保留 <script>alert(1)</script> 字样。\n',
    expected_revision: created.revision,
  })).revision;
  await new SourceStore(vault).importSource({ filename: 'guide.txt', text: '面板测试资料\n' });
  panel = await startPanel(vault, { port: 0 });
});

after(async () => {
  await panel?.close();
  const parent = await realpath(os.tmpdir());
  const resolved = await realpath(base);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('project-wiki-panel-test-')) {
    throw new Error('Refusing cleanup outside the test fixture directory.');
  }
  await rm(resolved, { recursive: true });
});

test('panel serves one locked-down page and only its own assets', async () => {
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.body, /知识库管理面板/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  for (const asset of ['/app.js', '/style.css']) {
    const response = await call(asset);
    assert.equal(response.status, 200, `${asset} is not served`);
    assert.ok(response.body.length > 0);
  }
  // The asset table is fixed, so request text can never reach the filesystem.
  assert.equal((await call('/../package.json')).status, 404);
});

test('panel advertises read-only mode, its locked reads and its two maintenance actions', async () => {
  const { status, body } = await call('/api/describe');
  assert.equal(status, 200);
  assert.equal(body.data.vault, await realpath(vault));
  assert.equal(body.data.note_editing, false);
  assert.equal(body.data.source_importing, false);
  assert.equal(body.data.arbitrary_commands, false);
  assert.deepEqual(body.data.maintenance_actions, ['rebuild_index', 'recover_lock']);
  assert.ok(body.data.locked_reads.includes('lint'));
});

test('note listing, search, reading and history reuse the knowledge store', async () => {
  const list = await call('/api/notes');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.mode, 'catalog');
  assert.equal(list.body.data.total, 1);
  const [entry] = list.body.data.entries;
  assert.equal(entry.title, '面板测试概念');
  assert.equal(entry.summary, '面板测试摘要');
  assert.deepEqual(entry.tags, ['测试']);
  assert.equal(entry.revision, updatedRevision);
  // A listing never ships note bodies.
  assert.equal(entry.content, undefined);

  const search = await call(`/api/notes?query=${encodeURIComponent('面板测试')}`);
  assert.equal(search.body.data.mode, 'search');
  assert.equal(search.body.data.entries.length, 1);

  const read = await call(note('面板测试概念'));
  assert.equal(read.status, 200);
  assert.equal(read.body.data.relativePath, 'wiki/concepts/面板测试概念.md');
  // Markdown is returned verbatim: the panel renders every value as text, never as markup.
  assert.match(read.body.data.rawMarkdown, /<script>alert\(1\)<\/script>/);
  assert.ok(!read.body.data.rawMarkdown.includes('&lt;script&gt;'));
  assert.equal(read.body.data.revision, updatedRevision);

  const history = await call(`/api/history?pathOrTitle=${encodeURIComponent('面板测试概念')}`);
  assert.equal(history.body.data.versions.length, 2);
  assert.equal(history.body.data.current_revision, updatedRevision);
  const oldest = history.body.data.versions.at(-1);
  const revision = await call(`/api/history?pathOrTitle=${encodeURIComponent('面板测试概念')}&revision=${oldest.revision}`);
  assert.match(revision.body.data.rawMarkdown, /第一版正文/);

  const missing = await call(note('不存在的笔记'));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOTE_NOT_FOUND');
});

test('sources, integrity check, lint, status, log, rules and index are available as reads', async () => {
  const sources = await call('/api/sources');
  assert.equal(sources.status, 200);
  assert.equal(sources.body.data.total, 1);
  assert.equal(sources.body.data.entries[0].integrity, 'ok');
  assert.equal(sources.body.data.entries[0].path, 'raw/guide.txt');
  assert.match(sources.body.data.compilation_status, /not_tracked/);

  const check = await call('/api/sources/check');
  assert.equal(check.status, 200);
  assert.equal(check.body.data.has_source_problems, false);
  // guide.txt is registered, so it is not an unregistered original; it is simply uncited.
  assert.deepEqual(check.body.data.unregistered_sources, []);
  assert.equal(check.body.data.sources[0].integrity, 'ok');

  const lint = await call('/api/lint');
  assert.equal(lint.status, 200);
  assert.equal(typeof lint.body.data.healthy, 'boolean');

  const status = await call('/api/status');
  assert.equal(status.body.data.notes.total, 1);
  assert.equal(status.body.data.notes.concepts, 1);
  assert.equal(status.body.data.sources.totalRaw, 1);

  const log = await call('/api/log?lines=50');
  assert.equal(log.body.data.available, true);
  assert.ok(log.body.data.lines.some(line => line.includes('面板测试概念')));

  const rules = await call('/api/rules');
  assert.ok(rules.body.data.markdown.length > 0);

  const index = await call('/api/index');
  assert.match(index.body.data.markdown, /面板测试概念/);
  const archived = await call('/api/index?include_archived=true');
  assert.equal(archived.body.data.include_archived, true);
});

test('panel rejects invalid query parameters instead of guessing', async () => {
  for (const query of ['limit=999', 'offset=-1', 'limit=abc']) {
    const response = await call(`/api/notes?${query}`);
    assert.equal(response.status, 400, `${query} was accepted`);
    assert.equal(response.body.error.code, 'INVALID_REQUEST');
  }
  const missing = await call('/api/note');
  assert.equal(missing.status, 400);
});

test('maintenance actions need explicit confirmation and never rewrite note bodies', async () => {
  const refused = await post('/api/maintenance/rebuild-index', {});
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'INVALID_REQUEST');
  assert.match(refused.body.error.message, /confirm/);

  const rebuilt = await post('/api/maintenance/rebuild-index', { confirm: true });
  assert.equal(rebuilt.status, 200);
  assert.equal(rebuilt.body.data.action, 'rebuild_index');
  assert.ok(rebuilt.body.data.transaction);
  assert.deepEqual(rebuilt.body.data.changed_paths, []);

  const lock = await post('/api/maintenance/recover-lock', { confirm: true });
  assert.equal(lock.status, 200);
  assert.equal(lock.body.data.action, 'recover_lock');
  assert.equal(lock.body.data.recovered, false);
  assert.equal(lock.body.data.reason, 'Vault is not locked.');

  // Maintenance touched the index and the log only: the note keeps the revision it had before.
  const read = await call(note('面板测试概念'));
  assert.equal(read.body.data.revision, updatedRevision);
  const after = await call('/api/status');
  assert.deepEqual(after.body.data.notes, { total: 1, active: 1, archived: 0, concepts: 1, entities: 0, syntheses: 0 });
});

test('panel refuses cross-origin requests, unknown routes and unsupported methods', async () => {
  const cross = await rawRequest(`${panel.url}api/describe`, { headers: { origin: 'http://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal(JSON.parse(cross.body).error.code, 'CROSS_ORIGIN');

  // A same-origin request is accepted, so the check rejects only foreign pages.
  const same = await rawRequest(`${panel.url}api/describe`, { headers: { origin: panel.url.replace(/\/$/, '') } });
  assert.equal(same.status, 200);

  assert.equal((await call('/api/nope')).status, 404);
  assert.equal((await call('/api/describe', { method: 'PUT' })).status, 405);
  const badBody = await call('/api/maintenance/rebuild-index', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(badBody.status, 400);
});

test('panel refuses a non-loopback bind without an explicit opt-in', async () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('127.0.0.53'), true);
  assert.equal(isLoopback('localhost'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('0.0.0.0'), false);
  assert.equal(isLoopback('192.168.1.5'), false);
  await assert.rejects(startPanel(vault, { port: 0, host: '0.0.0.0' }), /Refusing to bind the panel to 0\.0\.0\.0/);
});

test('panel reports a missing or non-vault directory instead of creating one', async () => {
  await assert.rejects(startPanel(path.join(base, 'absent'), { port: 0 }), /Vault not found/);
  await assert.rejects(startPanel(base, { port: 0 }), /Expected a Wiki vault with a wiki\/ directory/);
  await assert.rejects(startPanel(vault, { port: 99_999 }), /port must be an integer between 0 and 65535/);
});
