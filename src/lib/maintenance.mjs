import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NoteStore } from './note-store.mjs';
import { SourceStore } from './source-store.mjs';
import { FulltextStore } from './fulltext-store.mjs';
import { CompilationStore } from './compilation-store.mjs';
import { sourceKind } from './source-extraction.mjs';
import { MAX_SOURCE_BYTES } from './source-limits.mjs';
import { safePath, sha256, writeJson } from './vault-io.mjs';

const execute = promisify(execFile);
const excluded = new Set(['backup-manifest.json', '.wiki-server/write.lock', '.wiki-server/recovery.lock', '.wiki-server/fulltext', '.wiki-server/extractions', '.wiki-server/responses']);
const backupPattern = /^auto-vault-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]+\.tar\.gz$/;

async function fileInventory(root, relative = '') {
  const result = [];
  const directory = relative ? await safePath(root, relative) : root;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (excluded.has(name)) continue;
    if (entry.isSymbolicLink()) throw Error(`Backup refuses symlink: ${name}`);
    if (entry.isDirectory()) result.push(...await fileInventory(root, name));
    else if (entry.isFile()) result.push(name);
    else throw Error(`Backup refuses special file: ${name}`);
  }
  return result.sort();
}

export async function verifySnapshot(root) {
  const manifest = JSON.parse(await fs.readFile(await safePath(root, 'backup-manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw Error('Invalid backup manifest');
  const names = new Set(manifest.files.map(f => f.path));
  const actual = (await fileInventory(root)).filter(p => p !== 'backup-manifest.json');
  if (names.size !== manifest.files.length || actual.length !== names.size || actual.some(p => !names.has(p))) throw Error('Backup file list mismatch');
  for (const file of manifest.files) if (sha256(await fs.readFile(await safePath(root, file.path))) !== file.sha256) throw Error(`Backup hash mismatch: ${file.path}`);
  return { verified_files: actual.length, created_at: manifest.created_at };
}

export async function createBackup(root, destination) {
  if (process.platform === 'win32') throw Error('Server backup command requires Linux tar');
  root = await fs.realpath(root);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 }); destination = await fs.realpath(destination);
  if (destination === root || destination.startsWith(root + path.sep)) throw Error('Backup destination must be outside the vault');
  const temp = await fs.mkdtemp(path.join(destination, '.snapshot-'));
  const restore = await fs.mkdtemp(path.join(destination, '.restore-check-'));
  const stamp = new Date().toISOString().replaceAll(':', '-').replace('.', '-');
  const name = `auto-vault-${stamp}-${randomUUID()}.tar.gz`;
  const archive = path.join(destination, name);
  try {
    await new NoteStore(root).locked(async () => {
      const files = [];
      for (const relative of await fileInventory(root)) {
        const bytes = await fs.readFile(await safePath(root, relative));
        const target = path.join(temp, ...relative.split('/'));
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, bytes, { mode: 0o600 });
        files.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length });
      }
      await fs.writeFile(path.join(temp, 'backup-manifest.json'), JSON.stringify({ version: 1, created_at: new Date().toISOString(), files, excluded_regenerable: ['fulltext', 'extractions', 'responses'], restore: 'Extract into a new empty vault, verify manifest, regenerate caches, then explicitly switch the service. Never extract over an active vault.' }, null, 2), { mode: 0o600 });
    });
    await execute('tar', ['-czf', archive, '-C', temp, '.'], { timeout: 300000, maxBuffer: 1048576 });
    await fs.chmod(archive, 0o600);
    // Restore rehearsal for every backup, in a new isolated directory.
    await execute('tar', ['-xzf', archive, '--no-same-owner', '-C', restore], { timeout: 300000, maxBuffer: 1048576 });
    const verified = await verifySnapshot(restore);
    const checksum = sha256(await fs.readFile(archive));
    await fs.writeFile(archive + '.sha256', `${checksum}  ${name}\n`, { mode: 0o600 });
    const report = { archive, sha256: checksum, ...verified, restore_verified: true };
    await fs.writeFile(archive + '.json', JSON.stringify(report, null, 2), { mode: 0o600 });
    return report;
  } finally {
    // Only exact directories created by this invocation, under the configured backup parent.
    for (const directory of [temp, restore]) {
      if (path.dirname(await fs.realpath(directory)) !== destination || !/^\.(snapshot|restore-check)-/.test(path.basename(directory))) throw Error('Unsafe backup temporary path');
      await fs.rm(directory, { recursive: true });
    }
  }
}

export async function pruneBackups(destination) {
  destination = await fs.realpath(destination);
  const verified = [];
  for (const name of await fs.readdir(destination)) {
    if (!backupPattern.test(name)) continue;
    if (!(await fs.lstat(path.join(destination, name))).isFile()) continue;
    try { const r = JSON.parse(await fs.readFile(path.join(destination, name + '.json'))); if (r.restore_verified && /^[a-f0-9]{64}$/.test(r.sha256)) verified.push({ name, date: r.created_at }); } catch {}
  }
  verified.sort((a, b) => b.date.localeCompare(a.date));
  const keep = new Set(verified.slice(0, 14).map(v => v.name));
  const weeks = new Set();
  for (const v of verified) { const week = Math.floor(Date.parse(v.date) / 604800000); if (!Number.isFinite(week)) { keep.add(v.name); continue; } if (!weeks.has(week) && weeks.size < 8) { weeks.add(week); keep.add(v.name); } }
  const removed = [];
  for (const item of verified.filter(v => !keep.has(v.name))) {
    for (const suffix of ['', '.sha256', '.json']) { const target = path.join(destination, item.name + suffix); if (path.dirname(target) !== destination || (await fs.lstat(target)).isSymbolicLink()) throw Error('Unsafe retention target'); await fs.unlink(target); }
    removed.push(item.name);
  }
  return { retained: verified.length - removed.length, removed };
}

export async function maintainSources(root, incoming) {
  root = await fs.realpath(root); incoming = await fs.realpath(incoming);
  if (incoming === root || incoming.startsWith(root + path.sep)) throw Error('Incoming directory must be outside the vault');
  const sources = new SourceStore(root); const imports = []; const issues = [];
  for (const entry of await fs.readdir(incoming, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || /\.part$|\.tmp$/.test(entry.name)) continue;
    const file = path.join(incoming, entry.name); const before = await fs.stat(file);
    // Give uploads time to settle; upload to .part and rename for atomic readiness.
    if (Date.now() - before.mtimeMs < 60000) continue;
    try {
      if (before.size > MAX_SOURCE_BYTES) throw Error('File exceeds configured source limit');
      const bytes = await fs.readFile(file); const after = await fs.lstat(file);
      if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length > MAX_SOURCE_BYTES) throw Error('File changed while reading');
      if (sourceKind(entry.name, bytes) === 'unsupported') throw Error('Unsupported format: audio, video and archives are outside scope');
      const result = await sources.importSource({ filename: entry.name, base64: bytes.toString('base64') });
      if (!result.deduplicated) imports.push({ path: result.path, id: result.id });
    } catch (error) { issues.push({ file: entry.name, error: error.message }); }
  }
  // Existing registered raw files are never re-registered after an in-place change.
  for (const source of await new FulltextStore(root).inventory()) if (!source.registered) {
    try { await sources.registerSource({ path: source.path }); } catch (error) { issues.push({ file: source.path, error: error.message }); }
  }
  const index = await new FulltextStore(root).index();
  const check = await sources.checkSources();
  const queue = await new CompilationStore(root).queue({ limit: 1 });
  const report = { checked_at: new Date().toISOString(), imports, issues, index, source_problems: check.has_source_problems, affected_notes: check.affected_notes, compilation: queue.counts };
  await writeJson(root, '.wiki-server/maintenance-status.json', report);
  if (imports.length || issues.length || check.has_source_problems) await new NoteStore(root).appendLog({ operation: 'automatic-maintenance', title: 'Source intake and integrity check', details: [JSON.stringify({ imports, issues, source_problems: check.has_source_problems })] });
  return report;
}
