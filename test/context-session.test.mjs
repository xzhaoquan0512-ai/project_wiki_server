import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectAdapter, loadProjects } from '../src/lib/project-adapter.mjs';

// Exercises the context_session adapter against a real, if minimal, Python backend.
// The backend records the argv it actually received, so the assertions below check the
// argument construction and JSON contract of the adapter rather than a stand-in object.
// It is deliberately small: it claims nothing about the engineering value of a query.
const BACKEND = `#!/usr/bin/env python3
"""Minimal stand-in for a project's tools/docs/context_session.py.

It implements the same CLI surface the adapter drives, answers with bounded JSON on
stdout, and appends the argv it received to a JSONL file for inspection.
"""
import argparse, json, os, sys, time
from pathlib import Path

def build():
    parser = argparse.ArgumentParser(prog='context_session.py')
    parser.add_argument('--root', type=Path)
    names = ('begin', 'search', 'read', 'evidence', 'status', 'adjust-budget', 'run', 'help')
    sub = parser.add_subparsers(dest='operation', required=True)
    for name in names:
        child = sub.add_parser(name)
        child.add_argument('--root', type=Path, default=argparse.SUPPRESS)
        child.add_argument('--session')
        child.add_argument('--json', action='store_true')
        child.add_argument('--max-chars', type=int)
        child.add_argument('--response-format')
        child.add_argument('--lock-timeout', type=float)
        child.add_argument('--profile')
        child.add_argument('--budget', type=int)
        child.add_argument('--reason')
        child.add_argument('--kind')
        child.add_argument('--query')
        child.add_argument('--offset', type=int)
        child.add_argument('--limit', type=int)
        child.add_argument('--path-prefix')
        child.add_argument('--include-stale', action='store_true')
        child.add_argument('--include-views', action='store_true')
        child.add_argument('--path')
        child.add_argument('--id')
        child.add_argument('--section')
        child.add_argument('--pointer')
        child.add_argument('--start-line', type=int)
        child.add_argument('--end-line', type=int)
        child.add_argument('--start-column', type=int)
        child.add_argument('--command-index', type=int)
        child.add_argument('--stream')
        child.add_argument('--force', action='store_true')
        child.add_argument('--argv-file')
        child.add_argument('--timeout', type=float)
        child.add_argument('--max-bytes', type=int)
    return parser

def main():
    parser = build()
    argv = sys.argv[1:]
    options, unknown = parser.parse_known_args()
    try:
        sleep = float(os.environ.get('CONTEXT_SESSION_FIXTURE_DELAY', '0'))
    except ValueError:
        sleep = 0.0
    started = time.time()
    if sleep:
        time.sleep(sleep)
    if options.operation == 'run' and options.argv_file:
        try:
            payload = json.loads(Path(options.argv_file).read_text(encoding='utf-8'))
            command = payload if isinstance(payload, list) else ['not-a-list']
        except Exception as exc:
            command = ['unreadable: ' + str(exc)]
    else:
        command = None
    record = {
        'operation': options.operation,
        'session': options.session,
        'max_chars': options.max_chars,
        'profile': options.profile,
        'budget': options.budget,
        'reason': options.reason,
        'kind': options.kind,
        'query': options.query,
        'offset': options.offset,
        'limit': options.limit,
        'path_prefix': options.path_prefix,
        'include_stale': options.include_stale,
        'include_views': options.include_views,
        'path': options.path,
        'id': options.id,
        'section': options.section,
        'pointer': options.pointer,
        'start_line': options.start_line,
        'end_line': options.end_line,
        'start_column': options.start_column,
        'command_index': options.command_index,
        'stream': options.stream,
        'force': options.force,
        'argv_file': options.argv_file,
        'timeout': options.timeout,
        'max_bytes': options.max_bytes,
        'argv': argv,
        'unknown': unknown,
        'command': command,
        'started': started,
        'ended': time.time(),
    }
    record_path = os.environ.get('CONTEXT_SESSION_FIXTURE_RECORD')
    if not record_path:
        sys.stderr.write('CONTEXT_SESSION_FIXTURE_RECORD is not set\\n')
        return 2
    with open(record_path, 'a', encoding='utf-8') as handle:
        handle.write(json.dumps(record) + '\\n')
    session = options.session or 'CTX-fixture-1'
    payload = {
        'status': 'passed',
        'operation': options.operation,
        'session_id': session,
        'receipt_id': 'R-' + options.operation,
        'output_chars': 42,
        'trust': 'backend-reported, not verified here',
    }
    if options.operation == 'begin':
        payload['rules_available'] = True
        payload['next_step'] = 'read AGENTS.md'
    if options.operation == 'run':
        payload['command'] = command
    sys.stdout.write(json.dumps(payload))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
`;

// The adapter is exercised through a real child process, so Python is a genuine prerequisite
// here. Skip with a reason rather than fail the suite on a host without it; CI installs Python
// on both supported runners. python3 is tried second because some Linux images ship only that.
function resolvePython() {
  if (process.env.PROJECT_WIKI_TEST_PYTHON) return process.env.PROJECT_WIKI_TEST_PYTHON;
  for (const candidate of ['python', 'python3']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

const interpreter = resolvePython();
const noPython = 'python is unavailable, so the context_session backend cannot be exercised';

async function fixture(t, extra = {}) {
  const base = await realpath(os.tmpdir());
  const sandbox = await mkdtemp(path.join(base, 'project-context-session-'));
  t.after(async () => {
    const resolved = await realpath(sandbox);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith('project-context-session-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const root = path.join(sandbox, 'project');
  await mkdir(path.join(root, 'tools/docs'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  // read/evidence resolve the path before spawning, so the fixture files must exist.
  await writeFile(path.join(root, 'docs/notes.md'), '# Fixture note\n');
  await mkdir(path.join(root, 'build/logs'), { recursive: true });
  await writeFile(path.join(root, 'build/logs/test.txt'), 'fixture evidence\n');
  await writeFile(path.join(root, 'AGENTS.md'), '# Fixture project rules\n');
  const record = path.join(root, 'build/context-session-record.jsonl');
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(path.join(root, 'tools/docs/context_session.py'), BACKEND);
  const config = path.join(sandbox, 'projects.json');
  await writeFile(config, JSON.stringify({ projects: [{ id: 'demo', root, ...extra }] }) + '\n');
  const projects = await loadProjects(config);
  return { sandbox, root, record, config, projects };
}

function adapterFor(projects, sandbox) {
  return new ProjectAdapter(projects, undefined, { stateDirectory: path.join(sandbox, 'state') });
}

// Point the fixture backend at the run's record file through the environment, which is
// the only channel available without inventing an argument the real adapter does not send.
async function withRecord(record, callback) {
  const previous = process.env.CONTEXT_SESSION_FIXTURE_RECORD;
  process.env.CONTEXT_SESSION_FIXTURE_RECORD = record;
  try { return await callback(); }
  finally {
    if (previous === undefined) delete process.env.CONTEXT_SESSION_FIXTURE_RECORD;
    else process.env.CONTEXT_SESSION_FIXTURE_RECORD = previous;
  }
}

async function records(record) {
  try {
    const text = await readFile(record, 'utf8');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function latest(items) {
  assert.ok(items.length > 0, 'the backend recorded no invocation');
  return items[items.length - 1];
}

function projectOf(f) {
  const project = f.projects.get('demo');
  assert.equal(project.adapter, 'context_session');
  return project;
}

test('auto detects the context_session backend and starts a session with profile and budget', { skip: interpreter ? false : noPython }, async t => {
  const f = await fixture(t, { python: interpreter });
  const project = projectOf(f);
  assert.equal(project.script, path.join(f.root, 'tools/docs/context_session.py'));
  const adapter = adapterFor(f.projects, f.sandbox);
  await withRecord(f.record, async () => {
    const began = await adapter.call('begin', { project_id: 'demo', profile: 'engineering', budget: 96000, max_chars: 5000 });
    assert.equal(began.exit_code, 0);
    assert.equal(began.backend.status, 'passed');
    assert.equal(began.backend.rules_available, true);
    assert.equal(began.backend.session_id, 'CTX-fixture-1');
    assert.match(began.next_step, /AGENTS\.md/);
    const recorded = latest(await records(f.record));
    assert.equal(recorded.operation, 'begin');
    assert.equal(recorded.max_chars, 5000);
    assert.equal(recorded.profile, 'engineering');
    assert.equal(recorded.budget, 96000);
    assert.equal(recorded.session, null);
    // record.argv is sys.argv[1:], which excludes the script path itself.
    assert.equal(recorded.argv[0], 'begin');
    // The adapter passes the real filesystem path; Windows keeps its backslashes here.
    assert.ok(recorded.argv.includes('--root=' + f.root), recorded.argv.join(' '));
    assert.deepEqual(recorded.unknown, []);
  });
});

test('search and read translate every selector into backend arguments', { skip: interpreter ? false : noPython }, async t => {
  const f = await fixture(t, { python: interpreter });
  const adapter = adapterFor(f.projects, f.sandbox);
  const scope = { project_id: 'demo', session_id: 'CTX-fixture-1' };
  await withRecord(f.record, async () => {
    await adapter.call('search', {
      ...scope, query: 'dma buffer', kind: 'wiki', offset: 5, limit: 9, path_prefix: 'docs/notes',
      include_stale: true, include_views: true,
    });
    const search = latest(await records(f.record));
    assert.equal(search.operation, 'search');
    assert.equal(search.query, 'dma buffer');
    assert.equal(search.kind, 'wiki');
    assert.equal(search.offset, 5);
    assert.equal(search.limit, 9);
    assert.equal(search.path_prefix, 'docs/notes');
    assert.equal(search.include_stale, true);
    assert.equal(search.include_views, true);
    assert.equal(search.max_chars, 3000);

    await adapter.call('read', {
      ...scope, path: 'docs/notes.md', section: 'intro', pointer: '/result/text',
      start_line: 3, end_line: 8, start_column: 2, force: true, max_chars: 6000,
    });
    const read = latest(await records(f.record));
    assert.equal(read.operation, 'read');
    assert.equal(read.path, 'docs/notes.md');
    assert.equal(read.section, 'intro');
    assert.equal(read.pointer, '/result/text');
    assert.equal(read.start_line, 3);
    assert.equal(read.end_line, 8);
    assert.equal(read.start_column, 2);
    assert.equal(read.force, true);
    assert.equal(read.max_chars, 6000);

    await adapter.call('evidence', { ...scope, path: 'build/logs/test.txt', command_index: 2, stream: 'stderr' });
    const evidence = latest(await records(f.record));
    assert.equal(evidence.operation, 'evidence');
    assert.equal(evidence.path, 'build/logs/test.txt');
    assert.equal(evidence.command_index, 2);
    assert.equal(evidence.stream, 'stderr');

    await adapter.call('status', scope);
    assert.equal(latest(await records(f.record)).operation, 'status');
  });
});

test('git-status writes a fixed argv file the backend can read, and budget changes keep their reason', { skip: interpreter ? false : noPython }, async t => {
  const f = await fixture(t, { python: interpreter });
  const adapter = adapterFor(f.projects, f.sandbox);
  const scope = { project_id: 'demo', session_id: 'CTX-fixture-1' };
  await withRecord(f.record, async () => {
    const status = await adapter.call('git-status', scope);
    assert.equal(status.exit_code, 0);
    const recorded = latest(await records(f.record));
    assert.equal(recorded.operation, 'run');
    assert.equal(recorded.timeout, 20);
    assert.equal(recorded.max_bytes, 262144);
    assert.ok(recorded.argv_file.startsWith('build/docs/mcp/argv/git-status-'));
    const argv = await readFile(path.join(f.root, recorded.argv_file), 'utf8');
    assert.deepEqual(JSON.parse(argv), ['git', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
    assert.deepEqual(recorded.command, ['git', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal']);

    await adapter.call('adjust-budget', { ...scope, budget: 24000, reason: 'the task needs another wiki pass' });
    const adjusted = latest(await records(f.record));
    assert.equal(adjusted.operation, 'adjust-budget');
    assert.equal(adjusted.budget, 24000);
    assert.equal(adjusted.reason, 'the task needs another wiki pass');
  });
});

test('the adapter rejects selectors and paths the backend never asked for', { skip: interpreter ? false : noPython }, async t => {
  const f = await fixture(t, { python: interpreter });
  const adapter = adapterFor(f.projects, f.sandbox);
  const scope = { project_id: 'demo', session_id: 'CTX-fixture-1' };
  await withRecord(f.record, async () => {
    await assert.rejects(adapter.call('read', { ...scope, path: 'a.md', id: 'doc-1' }), /exactly one of path or id/);
    await assert.rejects(adapter.call('read', scope), /exactly one of path or id/);
    await assert.rejects(adapter.call('evidence', scope), /repository-relative path/);
    await assert.rejects(adapter.call('read', { ...scope, path: '../../outside.md' }), /inside the registered project/);
    await assert.rejects(adapter.call('read', { ...scope, path: 'C:/Windows/system32/drivers/etc/hosts' }), /repository-relative path/);
    await assert.rejects(adapter.call('search', { ...scope, query: 'x', snapshot_id: 'SNAP-1' }), /only by the generic adapter/);
    await assert.rejects(adapter.call('read', { ...scope, path: 'a.md', expected_hash: 'a'.repeat(64) }), /only by the generic adapter/);
    await assert.rejects(adapter.call('search', { project_id: 'demo', session_id: '../bad', query: 'x' }), /valid session_id/);
    await assert.rejects(adapter.call('search', { project_id: 'missing', session_id: 'CTX-fixture-1', query: 'x' }), /Unknown project_id/);
    assert.deepEqual(await records(f.record), []);
  });
});

test('calls sharing one session are serialized, so the backend never sees two at once', { skip: interpreter ? false : noPython }, async t => {
  const f = await fixture(t, { python: interpreter });
  const adapter = adapterFor(f.projects, f.sandbox);
  const scope = { project_id: 'demo', session_id: 'CTX-fixture-1' };
  process.env.CONTEXT_SESSION_FIXTURE_DELAY = '0.25';
  try {
    await withRecord(f.record, async () => {
      await Promise.all([
        adapter.call('status', scope),
        adapter.call('status', scope),
      ]);
    });
  } finally { delete process.env.CONTEXT_SESSION_FIXTURE_DELAY; }
  const both = await records(f.record);
  assert.equal(both.length, 2);
  assert.ok(both[1].started >= both[0].ended, `second call started at ${both[1].started} before the first ended at ${both[0].ended}`);
});

test('a backend that does not return JSON fails loudly instead of inventing a result', { skip: interpreter ? false : noPython }, async t => {
  const f = await fixture(t, { python: interpreter });
  await writeFile(path.join(f.root, 'tools/docs/context_session.py'), 'import sys\nsys.stdout.write("not json at all")\n');
  const adapter = adapterFor(f.projects, f.sandbox);
  await withRecord(f.record, async () => {
    await assert.rejects(adapter.call('begin', { project_id: 'demo' }), /did not return a complete JSON response/);
  });
});

test('a backend that exits non-zero keeps its stdout receipt as a failed result', { skip: interpreter ? false : noPython }, async t => {
  const f = await fixture(t, { python: interpreter });
  const script = `import json, sys\nsys.stdout.write(json.dumps({"status": "blocked", "reason": "budget exhausted", "receipt_id": "refusal-1"}))\nsys.exit(1)\n`;
  await writeFile(path.join(f.root, 'tools/docs/context_session.py'), script);
  const adapter = adapterFor(f.projects, f.sandbox);
  await withRecord(f.record, async () => {
    const result = await adapter.call('status', { project_id: 'demo', session_id: 'CTX-fixture-1' });
    assert.equal(result.exit_code, 1);
    assert.equal(result.backend.status, 'blocked');
    assert.equal(result.backend.receipt_id, 'refusal-1');
  });
});

test('a backend that prints nothing fails without leaking an unusable result', { skip: interpreter ? false : noPython }, async t => {
  const f = await fixture(t, { python: interpreter });
  await writeFile(path.join(f.root, 'tools/docs/context_session.py'), 'import sys\nsys.exit(3)\n');
  const adapter = adapterFor(f.projects, f.sandbox);
  await withRecord(f.record, async () => {
    await assert.rejects(adapter.call('begin', { project_id: 'demo' }), /Project query process failed/);
  });
});

