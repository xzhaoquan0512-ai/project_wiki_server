import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath, readdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../bin/project-wiki-server.mjs', import.meta.url));

async function fixture(t) {
  const base = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'project-wiki-cli-test-'));
  t.after(async () => {
    const resolved = await realpath(root);
    if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('project-wiki-cli-test-')) {
      throw new Error('Refusing cleanup outside the test fixture directory.');
    }
    await rm(resolved, { recursive: true });
  });
  return root;
}

async function cli(args, environment = {}) {
  try {
    const result = await execute(process.execPath, [entry, ...args], { windowsHide: true, env: { ...process.env, ...environment } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) { return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}

const blank = (...names) => Object.fromEntries(names.map(name => [name, '']));

test('CLI documents every command and environment variable it reads', async () => {
  const result = await cli(['--help']);
  assert.equal(result.code, 0);
  for (const text of ['init-vault', 'wiki', 'project', 'lock-status', 'recover-lock',
    'PROJECT_WIKI_VAULT', 'PROJECT_WIKI_CONFIG', 'PROJECT_WIKI_STATE', 'PROJECT_WIKI_LIBREOFFICE', 'absolute']) {
    assert.match(result.stdout, new RegExp(text), `--help omits ${text}`);
  }
});

test('CLI rejects unknown commands, extra arguments and relative environment paths', async t => {
  const root = await fixture(t);
  const unknown = await cli(['frobnicate']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown command/);
  const extra = await cli(['init-vault', path.join(root, 'vault'), 'surplus']);
  assert.notEqual(extra.code, 0);
  assert.match(extra.stderr, /Too many arguments/);
  // A relative default would otherwise resolve against the MCP client's working directory.
  for (const variable of ['PROJECT_WIKI_VAULT', 'PROJECT_WIKI_CONFIG']) {
    const command = variable === 'PROJECT_WIKI_VAULT' ? 'lock-status' : 'project';
    const relative = await cli([command], { ...blank('PROJECT_WIKI_VAULT', 'PROJECT_WIKI_CONFIG'), [variable]: 'relative/path' });
    assert.notEqual(relative.code, 0, `${variable} accepted a relative path`);
    assert.match(relative.stderr, new RegExp(`${variable} must be an absolute path`));
  }
});

test('CLI init-vault creates one vault and never overwrites an existing directory', async t => {
  const root = await fixture(t);
  const vault = path.join(root, 'vault');
  const created = await cli(['init-vault', vault], blank('PROJECT_WIKI_VAULT'));
  assert.equal(created.code, 0);
  assert.match(created.stdout, /Created empty vault/);
  const refused = await cli(['init-vault', vault], blank('PROJECT_WIKI_VAULT'));
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /already exists/);
});

test('CLI lock-status reports JSON for the selected vault and an absent one as unlocked', async t => {
  const root = await fixture(t);
  const vault = path.join(root, 'vault');
  await mkdir(path.join(vault, 'wiki'), { recursive: true });
  const clean = await cli(['lock-status', vault], blank('PROJECT_WIKI_VAULT'));
  assert.equal(clean.code, 0);
  assert.deepEqual(JSON.parse(clean.stdout), { locked: false, owner: null });
  // An absent vault is reported as unlocked rather than guessed at; the command never creates one.
  const absent = path.join(root, 'absent');
  const missing = await cli(['lock-status', absent], blank('PROJECT_WIKI_VAULT'));
  assert.equal(missing.code, 0);
  assert.deepEqual(JSON.parse(missing.stdout), { locked: false, owner: null });
  assert.equal(await readdir(root).then(names => names.includes('absent')), false);
});

test('CLI project command reports an unreadable registry instead of starting a server', async t => {
  const root = await fixture(t);
  const config = path.join(root, 'projects.json');
  await writeFile(config, '{"projects":');
  const result = await cli(['project', config], blank('PROJECT_WIKI_CONFIG'));
  assert.notEqual(result.code, 0);
  assert.notEqual(result.stderr.trim(), '');
});
