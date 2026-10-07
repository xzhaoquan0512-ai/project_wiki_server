import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initializeVault } from '../src/vault.mjs';
import { createBackup, maintainSources, verifySnapshot } from '../src/lib/maintenance.mjs';
import { SourceStore } from '../src/lib/source-store.mjs';
import { NoteStore } from '../src/lib/note-store.mjs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

test('maintenance deduplicates intake, preserves versions, reports tampering, and restores a complete backup', { skip: process.platform === 'win32' }, async t => {
  const parent = await fs.realpath(os.tmpdir()); const temp = await fs.mkdtemp(path.join(parent, 'wiki-maintenance-'));
  t.after(async () => { const p = await fs.realpath(temp); assert.equal(path.dirname(p), parent); assert.ok(path.basename(p).startsWith('wiki-maintenance-')); await fs.rm(p, { recursive: true }); });
  const root = await initializeVault(path.join(temp, 'vault')); const incoming = path.join(temp, 'incoming'); const backup = path.join(temp, 'backups'); await fs.mkdir(incoming);
  const upload = path.join(incoming, 'source.md'); const oldTime = new Date(Date.now() - 120000);
  await fs.writeFile(upload, 'First immutable version'); await fs.utimes(upload, oldTime, oldTime);
  let result = await maintainSources(root, incoming); assert.equal(result.imports.length, 1);
  assert.equal((await maintainSources(root, incoming)).imports.length, 0);
  const original = result.imports[0].path;
  await fs.writeFile(upload, 'Second immutable version'); await fs.utimes(upload, oldTime, oldTime);
  result = await maintainSources(root, incoming); assert.equal(result.imports.length, 1); assert.notEqual(result.imports[0].path, original);
  assert.equal(await fs.readFile(path.join(root, original), 'utf8'), 'First immutable version');
  await new NoteStore(root).write({ category: 'concepts', title: 'Intake evidence', content: 'Test note preserved by backup.', frontmatter: { sources: [original] } });
  const saved = await createBackup(root, backup); assert.ok(saved.restore_verified); assert.ok(saved.verified_files > 4);
  const restored = path.join(temp, 'restored'); await fs.mkdir(restored); await promisify(execFile)('tar', ['-xzf', saved.archive, '-C', restored]);
  assert.equal((await verifySnapshot(restored)).verified_files, saved.verified_files);
  assert.equal((await new SourceStore(restored).listSources()).entries.length, 2);
  // A restored vault remains a valid backup source; the old manifest is not recursively included.
  assert.ok((await createBackup(restored, backup)).restore_verified);
  await fs.writeFile(path.join(root, original), 'tampered original');
  const changed = await maintainSources(root, incoming); assert.ok(changed.source_problems);
  assert.equal(await fs.readFile(path.join(root, original), 'utf8'), 'tampered original');
});
