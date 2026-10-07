import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { connectLocal, callJson } from '../src/client.mjs';

// Opt-in end-to-end coverage against a real engineering project that ships its own
// tools/docs/context_session.py. No project path, note text, session or evidence content is
// stored in this repository: the operator points the variables below at a project on this
// machine, and a preset-but-unusable value skips the test with a reason instead of failing
// it, the same rule as the LibreOffice opt-in in test/office.test.mjs.
//
//   PROJECT_WIKI_REAL_PROJECT      absolute root of a project containing tools/docs/context_session.py
//   PROJECT_WIKI_REAL_PYTHON       interpreter for that backend (default: platform python)
//   PROJECT_WIKI_REAL_RULES        JSON array of additional startup rule paths (after AGENTS.md)
//   PROJECT_WIKI_REAL_QUERY        search text that must exist in the project
//   PROJECT_WIKI_REAL_PATH         repository-relative file whose first 40 lines are read
//   PROJECT_WIKI_REAL_EVIDENCE     repository-relative RUN/EVD record the backend must read
//   PROJECT_WIKI_REAL_GIT_TIMEOUT  seconds to allow project_git_status (default 30)
//
// The assertions cover what this service owns: the session round trip, the selectors it
// refuses before starting a process, the fixed argv and the wait it grants git-status, and
// the request file it must not leave in the project. Whether a particular document exists
// is the operator's input, not this service's guarantee.

function configuredProject() {
  const candidate = process.env.PROJECT_WIKI_REAL_PROJECT;
  if (!candidate || !path.isAbsolute(candidate) || !existsSync(candidate)) return undefined;
  return existsSync(path.join(candidate, 'tools/docs/context_session.py')) ? candidate : undefined;
}

const projectRoot = configuredProject();
const interpreter = process.env.PROJECT_WIKI_REAL_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const probe = spawnSync(interpreter, ['--version'], { encoding: 'utf8', windowsHide: true });
const skip = !projectRoot
  ? 'set PROJECT_WIKI_REAL_PROJECT to an absolute project root containing tools/docs/context_session.py to run this'
  : probe.error || probe.status !== 0 ? `${interpreter} is unavailable, so the real backend cannot be started` : false;

// Read text, not the default section outline. A successful first response can still be
// incomplete; follow line AND column so long lines are neither skipped nor read twice.
async function readLines(client, scope, args) {
  let line = 1;
  let column = 1;
  let hash;
  for (let pages = 1; pages <= 256; pages++) {
    const read = await callJson(client, 'project_read', {
      ...scope, ...args, start_line: line, start_column: column,
    });
    assert.equal(read.backend.status, 'passed');
    const result = read.backend.result;
    assert.equal(result.mode, 'lines');
    assert.ok(Array.isArray(result.blocks), 'the backend must return text blocks');
    assert.equal(result.source_changed, false, 'the selected file changed during the read');
    hash ??= result.sha256;
    assert.equal(result.sha256, hash);
    if (result.selection_complete) return pages;
    const nextLine = result.next_line;
    const nextColumn = result.next_column ?? 1;
    assert.ok(Number.isInteger(nextLine) && Number.isInteger(nextColumn) && nextColumn >= 1);
    assert.ok(nextLine > line || (nextLine === line && nextColumn > column), 'continuation did not advance');
    line = nextLine;
    column = nextColumn;
  }
  assert.fail('the read exceeded 256 pages without completing');
}

test('a real context_session project answers the tool surface and keeps no request file', { skip }, async t => {
  const extraRules = JSON.parse(process.env.PROJECT_WIKI_REAL_RULES ?? '[]');
  assert.ok(Array.isArray(extraRules) && extraRules.every(value => typeof value === 'string' && value.length > 0),
    'PROJECT_WIKI_REAL_RULES must be a JSON array of repository-relative paths');
  const base = await realpath(os.tmpdir());
  const work = await mkdtemp(path.join(base, 'project-real-test-'));
  t.after(async () => {
    const resolved = await realpath(work);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith('project-real-test-'));
    await rm(resolved, { recursive: true });
  });
  const config = path.join(work, 'projects.json');
  const entry = { id: 'real', root: projectRoot };
  if (process.env.PROJECT_WIKI_REAL_PYTHON) entry.python = process.env.PROJECT_WIKI_REAL_PYTHON;
  await writeFile(config, JSON.stringify({ projects: [entry] }));

  // Query sessions must live outside every registered project.
  const client = await connectLocal('project', config, { env: { PROJECT_WIKI_STATE: path.join(work, 'sessions') } });
  t.after(async () => { await client.close(); });

  const listed = await callJson(client, 'project_list');
  assert.equal(listed[0].adapter, 'context_session.py');

  // Explicit budget for startup rules, pagination and captures; remain a read-only query.
  const began = await callJson(client, 'project_begin', { project_id: 'real', profile: 'query', budget: 96000 });
  assert.equal(began.exit_code, 0);
  assert.equal(began.backend.status, 'passed');
  const session = began.backend.session ?? began.backend.session_id;
  // Every later call sends this value back through the adapter's own session validation, so
  // a backend identifier the service cannot reuse would break the whole tool surface.
  assert.match(session, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/);
  assert.match(began.next_step, /project_read/);
  const scope = { project_id: 'real', session_id: session };
  let rulePages = 0;
  for (const rule of new Set(['AGENTS.md', ...extraRules])) {
    rulePages += await readLines(client, scope, { path: rule, max_chars: 4000 });
  }
  t.diagnostic(`startup rules fully read in ${rulePages} responses in one query session`);

  const status = await callJson(client, 'project_session_status', { project_id: 'real', session_id: session });
  assert.equal(status.backend.status, 'passed');

  const query = process.env.PROJECT_WIKI_REAL_QUERY;
  const search = await callJson(client, 'project_search', { project_id: 'real', session_id: session, kind: 'docs', query: query ?? 'a', limit: 2 });
  assert.equal(search.exit_code, 0);
  assert.equal(typeof search.backend.result, 'object');
  if (query) assert.ok(search.backend.result.results?.length > 0, `the configured query ${JSON.stringify(query)} matched nothing`);

  if (process.env.PROJECT_WIKI_REAL_PATH) {
    const pages = await readLines(client, scope, { path: process.env.PROJECT_WIKI_REAL_PATH, end_line: 40, max_chars: 1600 });
    t.diagnostic(`configured file text read in ${pages} responses (up to line 40)`);
  } else t.diagnostic('PROJECT_WIKI_REAL_PATH is unset, so no real document read was exercised');

  // The wait is set explicitly: a mounted or large work tree can exceed the 20 second
  // default, and this test must not claim that a platform-specific default is enough.
  const seconds = Number(process.env.PROJECT_WIKI_REAL_GIT_TIMEOUT ?? 30);
  const argvDirectory = path.join(projectRoot, 'build/docs/mcp/argv');
  const before = await readdir(argvDirectory).catch(() => []);
  const first = await callJson(client, 'project_git_status', { project_id: 'real', session_id: session, timeout_seconds: seconds });
  const second = await callJson(client, 'project_git_status', { project_id: 'real', session_id: session, timeout_seconds: Math.min(120, seconds + 15) });
  assert.equal(first.backend.result.complete, true);
  assert.equal(second.backend.result.complete, true);
  const after = await readdir(argvDirectory).catch(() => []);
  const added = after.filter(name => !before.includes(name));
  assert.deepEqual(added, [], `the backend was left with request files: ${added.join(', ')}`);
  for (const [capture, allowed] of [[first, seconds], [second, Math.min(120, seconds + 15)]]) {
    const read = await callJson(client, 'project_read', {
      ...scope, path: capture.backend.result.manifest_path, start_line: 1, max_chars: 16000,
    });
    assert.equal(read.backend.result.selection_complete, true);
    const manifest = JSON.parse(read.backend.result.blocks.map(block => block.text).join('\n'));
    // The backend may prefix the executable with safe Git configuration switches.
    assert.deepEqual(manifest.argv.slice(-4), ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
    assert.equal(manifest.timeout_seconds, allowed);
    assert.equal(manifest.exit_code, 0);
  }
  const preview = first.backend.result.previews?.find(value => value.stream === 'stdout');
  const commit = preview?.blocks?.map(block => block.text).join('\n').match(/^# branch\.oid (\S+)/m)?.[1];
  t.diagnostic(`Git capture completed at ${first.observed_at}; commit ${commit ?? 'not in preview'}; session ${session}`);

  if (process.env.PROJECT_WIKI_REAL_EVIDENCE) {
    const evidence = await callJson(client, 'project_evidence', { project_id: 'real', session_id: session, path: process.env.PROJECT_WIKI_REAL_EVIDENCE });
    assert.equal(evidence.backend.status, 'passed');
  } else t.diagnostic('PROJECT_WIKI_REAL_EVIDENCE is unset, so no backend evidence record was exercised');

  const beforeBudget = await callJson(client, 'project_session_status', scope);
  const currentLimit = began.backend.session_budget.limit_chars;
  const budget = Math.min(512000, currentLimit + 8000);
  const adjusted = await callJson(client, 'project_adjust_budget', {
    project_id: 'real', session_id: session, budget, reason: 'integration test widens the budget for one more retrieval stage',
  });
  assert.equal(adjusted.backend.result.limit_chars, budget);
  assert.equal(adjusted.backend.result.context_reset, false);
  assert.equal(adjusted.backend.segment, beforeBudget.backend.segment);
  assert.equal(adjusted.backend.session_budget.body_output_chars, beforeBudget.backend.session_budget.body_output_chars);

  // Refusals this service owns, so they hold for every project regardless of its contents.
  await assert.rejects(callJson(client, 'project_read', { project_id: 'real', session_id: session, path: 'anything.md', id: 'DOC-1' }),
    /exactly one of path or id/);
  await assert.rejects(callJson(client, 'project_read', { project_id: 'real', session_id: session, path: '../outside.md' }),
    /repository-relative|inside the registered project/);
  await assert.rejects(callJson(client, 'project_read', { project_id: 'real', session_id: session, path: 'anything.md', expected_hash: 'a'.repeat(64) }),
    /only by the generic adapter/);
  await assert.rejects(callJson(client, 'project_search', { project_id: 'real', session_id: '../bad', query: 'a' }),
    /valid session_id/);
  await assert.rejects(callJson(client, 'project_search', { project_id: 'missing', session_id: session, query: 'a' }),
    /Unknown project_id/);
  await assert.rejects(callJson(client, 'project_git_status', { project_id: 'real', session_id: session, timeout_seconds: 0 }), /timeout_seconds/);
  await assert.rejects(callJson(client, 'project_git_status', { project_id: 'real', session_id: session, timeout_seconds: 121 }), /timeout_seconds/);
  await assert.rejects(callJson(client, 'project_evidence', { project_id: 'real', session_id: session }), /path|Invalid|invalid/);
});
