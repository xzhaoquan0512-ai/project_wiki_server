import { lstat, realpath, mkdir, readFile, open, rename, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Reject links, including links inside the vault: writes must have one unambiguous owner.
export async function safePath(root, relative, { allowMissing = false } = {}) {
  if (typeof relative !== 'string' || !relative || relative.length > 4096 || /[\x00-\x1f:]/u.test(relative)) {
    throw new Error('Expected a safe vault-relative path.');
  }
  const normalized = relative.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (path.posix.isAbsolute(normalized) || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Path must remain inside the vault and use portable file names.');
  }
  const canonical = await realpath(root);
  let current = canonical;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed in vault paths.');
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error('Path ancestor is not a directory.');
    } catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing) throw error;
    }
  }
  return current;
}

export async function readJson(root, relative, fallback) {
  try { return JSON.parse(await readFile(await safePath(root, relative), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw error;
  }
}

export async function atomicWrite(root, relative, data) {
  let target = await safePath(root, relative, { allowMissing: true });
  await mkdir(path.dirname(target), { recursive: true });
  target = await safePath(root, relative, { allowMissing: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close(); handle = undefined;
    await safePath(root, relative, { allowMissing: true });
    await rename(temporary, target);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export const writeJson = (root, relative, value) => atomicWrite(root, relative, `${JSON.stringify(value, null, 2)}\n`);

const queues = new Map();
export async function withVaultLock(root, action) {
  const canonical = await realpath(root);
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const meta = await safePath(canonical, '.wiki-server', { allowMissing: true });
    await mkdir(meta, { recursive: true });
    const lock = await safePath(canonical, '.wiki-server/write.lock', { allowMissing: true });
    const deadline = Date.now() + 8000;
    while (true) {
      try { await mkdir(lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) {
          const busy = new Error('Vault is locked by another writer. If its process crashed, inspect .wiki-server/write.lock/owner.json and recover the lock after stopping all writers.');
          busy.code = 'VAULT_LOCKED'; throw busy;
        }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    }
    const token = randomUUID();
    const ownerPath = '.wiki-server/write.lock/owner.json';
    try {
      await writeJson(canonical, ownerPath, { token, pid: process.pid, hostname: os.hostname(), started_at: new Date().toISOString() });
      return await action();
    } finally {
      // Never remove a replacement lock or recursively delete anything.
      const owner = await readJson(canonical, ownerPath, null);
      if (owner?.token === token) {
        await unlink(await safePath(canonical, ownerPath));
        await rmdir(await safePath(canonical, '.wiki-server/write.lock'));
      } else if (owner === null) {
        await rmdir(await safePath(canonical, '.wiki-server/write.lock')).catch(() => {});
      } else throw new Error('Vault lock ownership changed; refusing to remove it.');
    }
  });
  queues.set(key, current);
  try { return await current; }
  finally { if (queues.get(key) === current) queues.delete(key); }
}
