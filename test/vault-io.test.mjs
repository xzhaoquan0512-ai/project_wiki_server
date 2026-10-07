import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safePath, readJson, writeJson, withVaultLock } from '../src/lib/vault-io.mjs';
import { lockStatus, recoverAbandonedLock } from '../src/lib/vault-admin.mjs';
import matter from '../src/lib/frontmatter.mjs';

const execute = promisify(execFile);
test('frontmatter never evaluates executable language blocks', () => {
  const exploit = '---javascript\n(globalThis.__wikiExecuted = true, {title: "unsafe"})\n---\ntext';
  assert.throws(() => matter(exploit), /Executable/);
  assert.equal(globalThis.__wikiExecuted, undefined);
  assert.deepEqual(matter('---\ntitle: safe\n---\nbody').data, { title: 'safe' });
  assert.throws(() => matter('---\ntitle: incomplete'), /closing delimiter/);
  assert.throws(() => matter('---\nunsafe: !!js/function function() {}\n---\ntext'), /Invalid YAML/);
  assert.throws(() => matter('---\nx: &a [*a]\n---\ntext'), /acyclic|alias/i);
});
async function fixture(t) {
  const base = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'wiki-io-test-'));
  t.after(async () => {
    const target = await realpath(root);
    assert.equal(path.dirname(target), base);
    assert.ok(path.basename(target).startsWith('wiki-io-test-'));
    await rm(target, { recursive: true });
  });
  return root;
}

test('vault IO rejects links/traversal and never hides corrupt JSON', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'actual'));
  await symlink(path.join(root, 'actual'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of ['../out', 'x/../../out', '/abs', 'C:relative', 'link/data.json', 'x/CON.txt', 'x /file']) {
    await assert.rejects(safePath(root, name, { allowMissing: true }));
  }
  await writeJson(root, 'actual/state.json', { count: 1 });
  assert.deepEqual(await readJson(root, 'actual/state.json'), { count: 1 });
  assert.deepEqual(await readJson(root, 'missing.json', {}), {});
  await writeFile(path.join(root, 'bad.json'), 'broken');
  await assert.rejects(readJson(root, 'bad.json', {}), SyntaxError);
});

test('separate Node processes serialize vault writes without lost updates', async t => {
  const root = await fixture(t);
  await writeJson(root, 'count.json', { count: 0 });
  const moduleUrl = new URL('../src/lib/vault-io.mjs', import.meta.url).href;
  const script = `import {withVaultLock,readJson,writeJson} from ${JSON.stringify(moduleUrl)};
    const root=process.argv[1];
    for(let i=0;i<4;i++) await withVaultLock(root, async()=>{
      const value=await readJson(root,'count.json');
      await new Promise(r=>setTimeout(r,20));
      await writeJson(root,'count.json',{count:value.count+1});
    });`;
  await Promise.all([0, 1].map(() => execute(process.execPath, ['--input-type=module', '-e', script, root], { shell: false, windowsHide: true, timeout: 15000 })));
  assert.deepEqual(await readJson(root, 'count.json'), { count: 8 });
  assert.equal((await lockStatus(root)).locked, false);
});

test('lock recovery refuses active and foreign owners; exceptions release owned locks', async t => {
  const root = await fixture(t);
  await withVaultLock(root, async () => {
    assert.equal((await lockStatus(root)).owner.pid, process.pid);
    await assert.rejects(recoverAbandonedLock(root), /still exists/);
  });
  await assert.rejects(withVaultLock(root, async () => { throw new Error('deliberate'); }), /deliberate/);
  assert.equal((await lockStatus(root)).locked, false);
  await mkdir(path.join(root, '.wiki-server/write.lock'));
  await writeJson(root, '.wiki-server/write.lock/owner.json', { hostname: 'other-host', pid: 99999, token: 'fixture' });
  await assert.rejects(recoverAbandonedLock(root), /Cannot prove/);
  assert.equal((await lockStatus(root)).locked, true);
});

test('admin recovers a lock only after its local writer has actually exited', async t => {
  const root = await fixture(t);
  const moduleUrl = new URL('../src/lib/vault-io.mjs', import.meta.url).href;
  const script = `import {withVaultLock} from ${JSON.stringify(moduleUrl)}; await withVaultLock(process.argv[1], async()=>{process.exit(0);});`;
  await execute(process.execPath, ['--input-type=module', '-e', script, root], { shell: false, windowsHide: true, timeout: 5000 });
  assert.equal((await lockStatus(root)).locked, true);
  assert.equal((await recoverAbandonedLock(root)).recovered, true);
  assert.equal((await lockStatus(root)).locked, false);
  await withVaultLock(root, () => writeJson(root, 'resumed.json', { resumed: true }));
  assert.deepEqual(await readJson(root, 'resumed.json'), { resumed: true });
});

test('parallel recovery calls cannot both claim a dead lock', async t => {
  const root = await fixture(t);
  const moduleUrl = new URL('../src/lib/vault-io.mjs', import.meta.url).href;
  await execute(process.execPath, ['--input-type=module', '-e', `import {withVaultLock} from ${JSON.stringify(moduleUrl)}; await withVaultLock(process.argv[1], async()=>process.exit(0));`, root], { shell: false, windowsHide: true });
  const results = await Promise.allSettled([recoverAbandonedLock(root), recoverAbandonedLock(root)]);
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.recovered).length, 1);
  await withVaultLock(root, async () => {
    assert.equal((await lockStatus(root)).owner.pid, process.pid);
    await assert.rejects(recoverAbandonedLock(root), /still exists/);
    assert.equal((await lockStatus(root)).locked, true);
  });
});
