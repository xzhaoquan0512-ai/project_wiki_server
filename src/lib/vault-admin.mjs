import { lstat, unlink, rmdir, open, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { safePath, readJson, sha256 } from './vault-io.mjs';

export async function lockStatus(root) {
  try {
    const info = await lstat(await safePath(root, '.wiki-server/write.lock'));
    if (!info.isDirectory()) throw new Error('Invalid vault lock directory.');
    const owner = await readJson(root, '.wiki-server/write.lock/owner.json', null);
    return { locked: true, owner };
  } catch (error) {
    if (error.code === 'ENOENT') return { locked: false, owner: null };
    throw error;
  }
}

export async function recoverAbandonedLock(root) {
  // Serialize recovery itself: two inspectors must not delete a later writer's lock.
  await mkdir(await safePath(root, '.wiki-server', { allowMissing: true }), { recursive: true });
  const guardPath = '.wiki-server/recovery.lock';
  let guard;
  try { guard = await open(await safePath(root, guardPath, { allowMissing: true }), 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another recovery is running, or a recovery process crashed. Inspect .wiki-server/recovery.lock after stopping all recovery processes.');
    throw error;
  }
  const token = randomUUID();
  try {
    await guard.writeFile(JSON.stringify({ token, pid: process.pid, hostname: os.hostname() }));
    await guard.sync();
    return await recoverLocked(root);
  } finally {
    await guard.close();
    const current = await readJson(root, guardPath, null);
    if (current?.token === token) await unlink(await safePath(root, guardPath));
  }
}

async function recoverLocked(root) {
  const state = await lockStatus(root);
  if (!state.locked) return { recovered: false, reason: 'Vault is not locked.' };
  const owner = state.owner;
  if (!owner || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') {
    throw new Error('Cannot prove this lock is abandoned on this host. Stop all writers and inspect it manually.');
  }
  try {
    process.kill(owner.pid, 0);
    throw new Error('The lock owner process still exists. Stop the writer normally; do not unlock an active vault.');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const current = await readJson(root, '.wiki-server/write.lock/owner.json');
  if (sha256(JSON.stringify(owner)) !== sha256(JSON.stringify(current))) throw new Error('Lock changed during inspection.');
  // Exact files only. A different host or an uncertain process state never permits removal.
  await unlink(await safePath(root, '.wiki-server/write.lock/owner.json'));
  await rmdir(await safePath(root, '.wiki-server/write.lock'));
  return { recovered: true, former_owner: owner, next_step: 'Call a knowledge tool to finish any pending journaled operation under the vault lock.' };
}
