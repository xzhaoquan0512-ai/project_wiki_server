import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeVault } from '../src/vault.mjs';
import { SourceStore } from '../src/lib/source-store.mjs';
import { FulltextStore } from '../src/lib/fulltext-store.mjs';
import { CompilationStore } from '../src/lib/compilation-store.mjs';
import { NoteStore } from '../src/lib/note-store.mjs';

function pdf() {
  const stream = 'BT /F1 12 Tf 20 350 Td (DMA buffer test evidence for indexing) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test('PDF fulltext uses page hashes, excludes changed originals, tracks draft coverage and detects changed output notes', async t => {
  const parent = await realpath(os.tmpdir()); const temp = await mkdtemp(path.join(parent, 'wiki-fulltext-'));
  t.after(async () => { const p = await realpath(temp); assert.equal(path.dirname(p), parent); assert.ok(path.basename(p).startsWith('wiki-fulltext-')); await rm(p, { recursive: true }); });
  const root = await initializeVault(path.join(temp, 'vault'));
  const source = await new SourceStore(root).importSource({ filename: 'evidence.pdf', base64: pdf().toString('base64') });
  const full = new FulltextStore(root);
  assert.equal((await full.index()).results[0].status, 'indexed');
  assert.equal((await full.index()).results[0].status, 'unchanged');
  assert.equal((await full.status()).indexed_pages, 1);
  const found = await full.search({ query: 'buffer DMA' }); assert.equal(found.total, 1); assert.equal(found.entries[0].page, 1);
  assert.equal((await full.outline({ reference: source.id })).page_count, 1);
  const notes = new NoteStore(root); const progress = new CompilationStore(root);
  const note = await notes.write({ category: 'concepts', title: 'DMA evidence', content: 'Source p.1 is an indexing test, not hardware proof.', frontmatter: { sources: [source.path] } });
  const task = (await progress.queue()).entries[0];
  const input = { task_id: task.id, status: 'summarized', notes: [note.relativePath], coverage_note: 'Read all of PDF page 1; fixture text only, no diagram or hardware claims.', expected_revision: null };
  await progress.record(input);
  assert.equal((await progress.queue({ status: 'all' })).counts.summarized, 1);
  await assert.rejects(progress.record(input), /changed/);
  await notes.write({ category: 'concepts', title: 'DMA evidence', content: 'Changed assessment requiring recheck.', expected_revision: note.revision });
  assert.equal((await progress.queue({ status: 'all' })).counts.needs_review, 1);
  assert.match(await readFile(path.join(root, 'wiki/log.md'), 'utf8'), /record-compilation/);
  await writeFile(path.join(root, source.path), 'changed original');
  assert.equal((await full.search({ query: 'DMA' })).total, 0);
  assert.equal((await full.status()).sources[0].indexed, false);
  assert.equal((await progress.queue()).total_tasks, 0);
});
