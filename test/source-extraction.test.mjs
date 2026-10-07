import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile, readdir, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import iconv from 'iconv-lite';
import { createCanvas } from '@napi-rs/canvas';
import { initializeVault } from '../src/vault.mjs';
import { SourceStore } from '../src/lib/source-store.mjs';
import { connectLocal, callJson } from '../src/client.mjs';
import { createExtractionQueue } from '../src/lib/extractors/queue.mjs';
import { boundExtractionResult } from '../src/lib/extractors/result-bounds.mjs';

async function fixture(t) {
  const parent = await realpath(os.tmpdir());
  const temporary = await mkdtemp(path.join(parent, 'wiki-extraction-test-'));
  t.after(async () => {
    const resolved = await realpath(temporary);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('wiki-extraction-test-')) throw new Error('Unsafe fixture cleanup.');
    await rm(resolved, { recursive: true });
  });
  const root = await initializeVault(path.join(temporary, 'vault'));
  return { root, temporary, store: new SourceStore(root) };
}

function zip(parts) {
  const archive = XLSX.CFB.utils.cfb_new();
  for (const [name, text] of parts) XLSX.CFB.utils.cfb_add(archive, name, Buffer.from(text));
  return XLSX.CFB.write(archive, { type: 'buffer', fileType: 'zip' });
}

test('real stdio source reader exposes document extraction, locations and local image OCR', async t => {
  const { root } = await fixture(t);
  const client = await connectLocal('wiki', root);
  t.after(() => client.close());
  const faults = []; client.onerror = error => faults.push(error.message);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['型号', '数量'], ['STM32', 3]]), '器件');
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const formats = [
    ['sample.docx', zip([['word/document.xml', '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>中文原始资料</w:t></w:r></w:p></w:body></w:document>']]), '中文原始资料', 'paragraph'],
    ['sample.xlsx', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'STM32', 'sheet'],
    ['sample.pptx', zip([
      ['ppt/presentation.xml', '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="one"/></p:sldIdLst></p:presentation>'],
      ['ppt/_rels/presentation.xml.rels', `<Relationships><Relationship Id="one" Target="slides/slide1.xml" Type="${ns}/slide"/></Relationships>`],
      ['ppt/slides/slide1.xml', '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>演示资料</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'],
    ]), '演示资料', 'slide'],
    ['sample.html', Buffer.from('<html><script>do not run</script><h1>网页标题</h1><p>原始证据</p></html>'), '原始证据', 'html_node'],
    ['sample.xml', Buffer.from('<root><item code="A">结构化证据</item></root>'), '结构化证据', 'xml_node'],
  ];
  for (const [filename, bytes, expected, locator] of formats) {
    const source = await callJson(client, 'wiki_import_source', { filename, base64: bytes.toString('base64') });
    const read = await callJson(client, 'wiki_read_source', { reference: source.id });
    assert.ok(read.units.some(unit => unit.text.includes(expected)), filename);
    assert.equal(read.units[0].locator.kind, locator, filename);
    assert.equal(read.source.integrity, 'ok');
    assert.equal(read.content_is_untrusted, true);
    assert.deepEqual(await readFile(path.join(root, source.path)), bytes);
  }
  const canvas = createCanvas(700, 100), context = canvas.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, 700, 100);
  context.fillStyle = 'black'; context.font = '44px sans-serif'; context.fillText('PROJECT WIKI 2026', 20, 65);
  const image = await callJson(client, 'wiki_import_source', { filename: 'scan.png', base64: canvas.toBuffer('image/png').toString('base64') });
  const recognized = await callJson(client, 'wiki_read_source', { reference: image.id, languages: 'eng' });
  assert.match(recognized.units[0].text, /PROJECT WIKI 2026/);
  assert.equal(recognized.units[0].method, 'ocr');
  assert.equal((await callJson(client, 'wiki_list_sources')).total, 6);
  assert.deepEqual(faults, []);
});

test('extraction pagination is lossless, caches by content and options, and does not hide changed originals', async t => {
  const { root, store } = await fixture(t);
  const content = '中文🙂'.repeat(60);
  const source = await store.importSource({ filename: 'long.html', text: `<p>${content}</p><p>第二段</p>` });
  const first = await store.readSource({ reference: source.id, max_chars: 101 });
  assert.equal(first.cache.hit, false);
  let joined = first.units.map(unit => unit.text).join(''), next = first.next;
  while (next) {
    const chunk = await store.readSource({ reference: source.id, ...next, max_chars: 101 });
    assert.equal(chunk.cache.hit, true);
    assert.equal(chunk.cache.key, first.cache.key);
    joined += chunk.units.map(unit => unit.text).join(''); next = chunk.next;
  }
  assert.equal(joined, content + '第二段');
  assert.equal((await store.readSource({ reference: source.id, view: 'raw' })).text, `<p>${content}</p><p>第二段</p>`);
  const alteredEncoding = await store.readSource({ reference: source.id, encoding: 'utf-8' });
  assert.notEqual(alteredEncoding.cache.key, first.cache.key);
  await writeFile(path.join(root, source.path), '<p>Externally changed original</p>');
  const changed = await store.readSource({ reference: source.id });
  assert.equal(changed.source.integrity, 'changed');
  assert.equal(changed.units[0].text, 'Externally changed original');
  assert.notEqual(changed.cache.key, first.cache.key);
  const cachePath = path.join(root, '.wiki-server/extractions', `${changed.cache.key}.json`);
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  cache.result.units[0].text = 'corrupted cache';
  await writeFile(cachePath, JSON.stringify(cache));
  const repaired = await store.readSource({ reference: source.id });
  assert.equal(repaired.cache.hit, false);
  assert.equal(repaired.units[0].text, 'Externally changed original');
});

test('readers decode declared and explicit Chinese encodings and expose extraction truncation', async t => {
  const { store } = await fixture(t);
  const html = '<meta charset="gbk"><p>中文网页</p>';
  const source = await store.importSource({ filename: 'gbk.html', base64: iconv.encode(html, 'gbk').toString('base64') });
  const read = await store.readSource({ reference: source.id });
  assert.equal(read.units[0].text, '中文网页');
  assert.equal(read.metadata.encoding, 'gbk');
  const text = await store.importSource({ filename: 'gbk.txt', base64: iconv.encode('中文文本', 'gbk').toString('base64') });
  await assert.rejects(store.readSource({ reference: text.id }), /not valid/);
  assert.equal((await store.readSource({ reference: text.id, encoding: 'gbk' })).text, '中文文本');
  const long = await store.importSource({ filename: 'truncated.html', text: `<p>${'A'.repeat(100001)}</p>` });
  assert.equal((await store.readSource({ reference: long.id })).truncated, true);
});

test('wrong-format selectors and omitted formats fail clearly, and cache paths reject links', async t => {
  const { root, temporary, store } = await fixture(t);
  const source = await store.importSource({ filename: 'selectors.xml', text: '<root>text</root>' });
  for (const options of [{ page: 2 }, { start_line: 1 }, { offset: 1 }, { ocr: 'force' }]) {
    await assert.rejects(store.readSource({ reference: source.id, ...options }), /not applicable/);
  }
  for (const filename of ['sample.mp3', 'sample.mp4', 'sample.zip']) {
    const item = await store.importSource({ filename, text: `placeholder ${filename}` });
    await assert.rejects(store.readSource({ reference: item.id }), /not extractable/);
  }
  const outside = path.join(temporary, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(root, '.wiki-server/extractions'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.readSource({ reference: source.id }), /links/);
  assert.deepEqual(await readdir(outside), []);
});

test('expired queued extraction is skipped and auxiliary metadata cannot dominate the response', async () => {
  const enqueue = createExtractionQueue({ max_pending: 2, wait_ms: 30 });
  let release, called = false;
  const active = enqueue(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const waiting = enqueue(() => { called = true; });
  await assert.rejects(enqueue(() => {}), /queue is full/);
  await assert.rejects(waiting, /cancelled before parsing/);
  release(); await active;
  assert.equal(await enqueue(() => 'recovered'), 'recovered');
  assert.equal(called, false);
  const result = boundExtractionResult({ units: [{ text: 'evidence', locator: { kind: 'paragraph', paragraph: 1 } }], warnings: [], metadata: { giant: ['A'.repeat(20000)], count: 1 } });
  assert.equal(result.metadata.metadata_truncated, true);
  assert.equal(result.metadata.count, 1);
  assert.ok(JSON.stringify(result).length < 1000);
  assert.throws(() => boundExtractionResult({ units: [{ text: 'evidence', locator: { path: 'A'.repeat(3000) } }] }), /locator/);
});

/** Two-page PDF: page selection must be part of the extraction cache identity, not a global option set. */
function twoPagePdf() {
  const stream = page => `BT /F1 24 Tf 72 700 Td (${page}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream('PAGE-ONE').length} >>\nstream\n${stream('PAGE-ONE')}\nendstream`,
    `<< /Length ${stream('PAGE-TWO').length} >>\nstream\n${stream('PAGE-TWO')}\nendstream`,
  ];
  let body = '%PDF-1.4\n', offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const startxref = Buffer.byteLength(body);
  const table = offsets.map((offset, index) => `${String(offset).padStart(10, '0')} ${String(index + 1).padStart(5, '0')} n \n`).join('');
  return Buffer.from(`${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`);
}

test('PDF page and OCR options belong to the extraction cache identity', async t => {
  const { store } = await fixture(t);
  const source = await store.importSource({ filename: 'two-pages.pdf', base64: twoPagePdf().toString('base64') });
  const first = await store.readSource({ reference: source.id, page: 1, ocr: 'off' });
  assert.equal(first.cache.hit, false);
  assert.match(first.pages[0].text, /PAGE-ONE/);
  const second = await store.readSource({ reference: source.id, page: 2, ocr: 'off' });
  assert.match(second.pages[0].text, /PAGE-TWO/, 'a different page must not be served from the page-1 cache entry');
  assert.notEqual(second.cache.key, first.cache.key);
  const languages = await store.readSource({ reference: source.id, page: 1, ocr: 'off', languages: 'eng' });
  assert.notEqual(languages.cache.key, first.cache.key);
  const repeated = await store.readSource({ reference: source.id, page: 2, ocr: 'off' });
  assert.equal(repeated.cache.hit, true);
  assert.equal(repeated.cache.key, second.cache.key);
});
