import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import XLSX from 'xlsx';
import { extractOffice } from '../src/lib/extractors/office.mjs';
import { MAX_SOURCE_BYTES, MAX_SOURCE_MIB } from '../src/lib/source-limits.mjs';

// An opt-in converter path, but only when it is an absolute path that really exists.
// path.isAbsolute() alone is not enough: on Windows it accepts '/usr/bin/soffice', a
// POSIX path that is absolute by its rules while naming no executable on that host. A
// preset-but-missing converter must skip this opt-in test rather than fail it.
function configuredConverter() {
  const candidate = process.env.PROJECT_WIKI_LIBREOFFICE_TEST;
  return candidate && path.isAbsolute(candidate) && existsSync(candidate) ? candidate : undefined;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [filename, content] of files) {
    const name = Buffer.from(filename);
    const data = Buffer.from(content);
    const compressed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(data), 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

const relNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const drawNs = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const pptNs = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const relationships = items => `<Relationships xmlns="${relNs}">${items}</Relationships>`;
const rel = (id, target, type, extra = '') => `<Relationship Id="${id}" Target="${target}" Type="${officeRel}/${type}" ${extra}/>`;
const paragraph = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const wordDoc = body => `<w:document xmlns:w="${wordNs}" xmlns:r="${officeRel}"><w:body>${body}<w:sectPr/></w:body></w:document>`;

function packageFiles(kind, mainXml, more = []) {
  const [main, type] = kind === 'docx' ? ['word/document.xml', 'wordprocessingml.document'] : kind === 'xlsx' ? ['xl/workbook.xml', 'spreadsheetml.sheet'] : ['ppt/presentation.xml', 'presentationml.presentation'];
  return [
    ['[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`],
    ['_rels/.rels', relationships(rel('rId1', main, 'officeDocument'))],
    [main, mainXml], ...more,
  ];
}

test('DOCX extracts Chinese paragraphs, tables, header text and links without executing fields', async () => {
  const table = `<w:tbl><w:tr><w:tc>${paragraph('型号')}</w:tc><w:tc>${paragraph('数量')}</w:tc></w:tr><w:tr><w:tc>${paragraph('STM32')}</w:tc><w:tc>${paragraph('3')}</w:tc></w:tr></w:tbl>`;
  const doc = wordDoc(`${paragraph('中文原始文档')}<w:p><w:hyperlink r:id="external"><w:r><w:t>外部链接名称</w:t></w:r></w:hyperlink><w:r><w:instrText>DDE dangerous.exe</w:instrText><w:t>缓存值</w:t></w:r></w:p>${table}`);
  const bytes = zip(packageFiles('docx', doc, [
    ['word/_rels/document.xml.rels', relationships(rel('head', 'header1.xml', 'header') + rel('external', 'https://127.0.0.1/never-fetch', 'hyperlink', 'TargetMode="External"'))],
    ['word/header1.xml', `<w:hdr xmlns:w="${wordNs}">${paragraph('页眉')}</w:hdr>`],
  ]));
  const result = await extractOffice(bytes, { filename: 'example.docx' });
  assert.equal(result.format, 'docx');
  assert.deepEqual(result.units.map(unit => unit.locator.kind), ['paragraph', 'paragraph', 'table', 'paragraph']);
  assert.equal(result.units[0].text, '中文原始文档');
  assert.equal(result.units[1].text, '外部链接名称缓存值');
  assert.equal(result.units[2].text, '型号\t数量\nSTM32\t3');
  assert.equal(result.units[3].locator.part, 'word/header1.xml');
  assert.match(result.warnings.join('\n'), /External Office links/);
});

test('XLSX respects workbook order and preserves coordinates, formulas, cached values and merged ranges', async () => {
  const workbook = `<workbook xmlns="${sheetNs}" xmlns:r="${officeRel}"><sheets><sheet name="第二份" sheetId="2" r:id="r2"/><sheet name="第一份" sheetId="1" state="hidden" r:id="r1"/></sheets></workbook>`;
  const firstSheet = `<worksheet xmlns="${sheetNs}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(2,3)</f><v>5</v></c><c r="C1" t="b"><v>1</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>内联文本</t></is></c></row></sheetData><mergeCells><mergeCell ref="A1:A2"/></mergeCells></worksheet>`;
  const secondSheet = `<worksheet xmlns="${sheetNs}"><sheetData><row r="5"><c r="C5"><v>42</v></c></row></sheetData></worksheet>`;
  const bytes = zip(packageFiles('xlsx', workbook, [
    ['xl/_rels/workbook.xml.rels', relationships(rel('r1', 'worksheets/sheet1.xml', 'worksheet') + rel('r2', 'worksheets/sheet2.xml', 'worksheet'))],
    ['xl/sharedStrings.xml', `<sst xmlns="${sheetNs}"><si><r><t>共享</t></r><r><t>文本</t></r></si></sst>`],
    ['xl/worksheets/sheet1.xml', firstSheet], ['xl/worksheets/sheet2.xml', secondSheet],
  ]));
  const result = await extractOffice(bytes, { filename: 'test.xlsx' });
  assert.deepEqual(result.units.map(unit => unit.locator.sheet), ['第二份', '第一份']);
  assert.equal(result.units[0].text, 'C5: 42');
  assert.match(result.units[1].text, /A1: 共享文本\tB1: =SUM\(2,3\) \[cached: 5\]\tC1: TRUE/);
  assert.match(result.units[1].text, /A3: 内联文本/);
  assert.deepEqual(result.metadata.sheets[1].merged_cells, ['A1:A2']);
  assert.equal(result.metadata.sheets[1].state, 'hidden');
  assert.equal(result.units[1].locator.row_end, 3);
});

test('PPTX honors presentation relationship order and reads speaker notes and tables', async () => {
  const presentation = `<p:presentation xmlns:p="${pptNs}" xmlns:relations="${officeRel}"><p:sldIdLst><p:sldId id="257" relations:id="b"/><p:sldId id="256" relations:id="a"/></p:sldIdLst></p:presentation>`;
  const slide = body => `<p:sld xmlns:p="${pptNs}" xmlns:a="${drawNs}"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
  const text = value => `<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>${value}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const table = '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>表格单元格</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  const bytes = zip(packageFiles('pptx', presentation, [
    ['ppt/_rels/presentation.xml.rels', relationships(rel('a', 'slides/slide1.xml', 'slide') + rel('b', 'slides/slide2.xml', 'slide'))],
    ['ppt/slides/slide1.xml', slide(text('幻灯片第二页'))],
    ['ppt/slides/slide2.xml', slide(text('幻灯片第一页') + table)],
    ['ppt/slides/_rels/slide2.xml.rels', relationships(rel('notes', '../notesSlides/notesSlide1.xml', 'notesSlide'))],
    ['ppt/notesSlides/notesSlide1.xml', `<p:notes xmlns:p="${pptNs}" xmlns:a="${drawNs}"><p:cSld><p:spTree>${text('演讲者备注')}</p:spTree></p:cSld></p:notes>`],
  ]));
  const result = await extractOffice(bytes, { filename: 'slides.pptx' });
  assert.deepEqual(result.units.map(unit => [unit.locator.slide, unit.locator.section]), [[1, 'content'], [1, 'notes'], [2, 'content']]);
  assert.equal(result.units[0].text, '幻灯片第一页\n表格单元格');
  assert.equal(result.units[1].text, '演讲者备注');
  assert.equal(result.units[2].text, '幻灯片第二页');
});

test('XLS extracts an actual BIFF8/OLE workbook without calculating formulas', async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['名称', '计算结果'], ['中文', 6]]);
  sheet.B2.f = '2*3';
  XLSX.utils.book_append_sheet(workbook, sheet, '工程数据');
  // SheetJS CE writes cached values but does not compile BIFF formula tokens.
  // Replace the generated B2 NUMBER record with a genuine BIFF8 FORMULA record:
  // ptgInt(2), ptgInt(3), ptgMul, cached value deliberately 99 (not 6).
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { bookType: 'xls', type: 'buffer' }), { type: 'buffer' });
  const entry = XLSX.CFB.find(cfb, 'Workbook');
  let replaced = false;
  for (let offset = 0; offset + 4 <= entry.content.length;) {
    const id = entry.content.readUInt16LE(offset), size = entry.content.readUInt16LE(offset + 2);
    if (id === 0x0203 && entry.content.readUInt16LE(offset + 4) === 1 && entry.content.readUInt16LE(offset + 6) === 1) {
      const record = Buffer.alloc(33);
      record.writeUInt16LE(0x0006); record.writeUInt16LE(29, 2);
      entry.content.copy(record, 4, offset + 4, offset + 10);
      record.writeDoubleLE(99, 10); record.writeUInt16LE(7, 24);
      Buffer.from([0x1e, 2, 0, 0x1e, 3, 0, 0x05]).copy(record, 26);
      const content = Buffer.concat([entry.content.subarray(0, offset), record, entry.content.subarray(offset + 4 + size)]);
      XLSX.CFB.utils.cfb_add(cfb, 'Workbook', content);
      replaced = true;
      break;
    }
    offset += 4 + size;
  }
  assert.equal(replaced, true);
  const bytes = XLSX.CFB.write(cfb, { type: 'buffer' });
  assert.equal(bytes.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1');
  const result = await extractOffice(bytes, { filename: 'legacy.xls' });
  assert.equal(result.units[0].locator.sheet, '工程数据');
  assert.match(result.units[0].text, /A1: 名称/);
  assert.match(result.units[0].text, /B2: =2\*3 \[cached: 99\]/);
  assert.match(result.warnings.join('\n'), /not executed/);
});

test('Office parser rejects traversal, duplicate parts, encrypted/invalid bytes and oversized expanded parts', async () => {
  await assert.rejects(extractOffice(zip([['../escape.xml', 'a']]), { kind: 'docx' }), /invalid relative path|invalid characters|relative path/i);
  await assert.rejects(extractOffice(zip([['word/document.xml', wordDoc('')], ['word/document.xml', wordDoc('')]]), { kind: 'docx' }), /Duplicate Office package/);
  await assert.rejects(extractOffice(Buffer.from('not-a-package'), { kind: 'docx' }), /Invalid or encrypted/);
  await assert.rejects(extractOffice(zip([['word/document.xml', Buffer.alloc(10 * 1024 * 1024 + 1, 65)]]), { kind: 'docx' }), /10 MiB/);
});

test('Office parser rejects XML entities/deep trees and invalid relationship targets', async () => {
  const entities = `<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///private">]>${wordDoc(paragraph('&x;'))}`;
  await assert.rejects(extractOffice(zip(packageFiles('docx', entities)), { kind: 'docx' }), /DTD\/entity/);
  await assert.rejects(extractOffice(zip(packageFiles('docx', wordDoc('<x>'.repeat(150) + '</x>'.repeat(150)))) , { kind: 'docx' }), /depth limit/);
  const files = packageFiles('docx', wordDoc(paragraph('ok')), [['word/_rels/document.xml.rels', relationships(rel('escape', '../../outside.xml', 'header'))]]);
  await assert.rejects(extractOffice(zip(files), { kind: 'docx' }), /escapes its package/);
});

test('XLSX rejects amplified sheet names, invalid states and malformed merged coordinates', async () => {
  const source = (name, state = 'visible', merge = 'A1:B2') => zip(packageFiles('xlsx', `<workbook xmlns="${sheetNs}" xmlns:r="${officeRel}"><sheets><sheet name="${name}" sheetId="1" state="${state}" r:id="r1"/></sheets></workbook>`, [
    ['xl/_rels/workbook.xml.rels', relationships(rel('r1', 'worksheets/sheet1.xml', 'worksheet'))],
    ['xl/worksheets/sheet1.xml', `<worksheet xmlns="${sheetNs}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>X</t></is></c></row></sheetData><mergeCells><mergeCell ref="${merge}"/></mergeCells></worksheet>`],
  ]));
  await assert.rejects(extractOffice(source('S'.repeat(100000)), { kind: 'xlsx' }), /1-31 characters/);
  await assert.rejects(extractOffice(source('safe', 'unexpected'), { kind: 'xlsx' }), /visibility state/);
  await assert.rejects(extractOffice(source('safe', 'visible', 'A1:XFE2'), { kind: 'xlsx' }), /row\/column limits/);
  await assert.rejects(extractOffice(source('safe', 'visible', 'B2:A1'), { kind: 'xlsx' }), /Reversed merged/);
  await assert.rejects(extractOffice(source('safe', 'visible', 'A1:'.repeat(1000)), { kind: 'xlsx' }), /Invalid merged/);
  await assert.rejects(extractOffice(zip([['word/' + 'a'.repeat(1000) + '.xml', 'ignored']]), { kind: 'docx' }), /256-character/);
});

test('XLSX metadata is bounded across many sheets and merged ranges without losing sheet text', async () => {
  const count = 160;
  const sheetElements = [], relElements = [], worksheetParts = [];
  for (let index = 1; index <= count; index++) {
    sheetElements.push(`<sheet name="Sheet ${index}" sheetId="${index}" r:id="r${index}"/>`);
    relElements.push(rel(`r${index}`, `worksheets/sheet${index}.xml`, 'worksheet'));
    const merges = Array.from({ length: 40 }, (_, row) => `<mergeCell ref="A${row + 1}:B${row + 1}"/>`).join('');
    worksheetParts.push([`xl/worksheets/sheet${index}.xml`, `<worksheet xmlns="${sheetNs}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Sheet text ${index}</t></is></c></row></sheetData><mergeCells>${merges}</mergeCells></worksheet>`]);
  }
  const workbook = `<workbook xmlns="${sheetNs}" xmlns:r="${officeRel}"><sheets>${sheetElements.join('')}</sheets></workbook>`;
  const result = await extractOffice(zip(packageFiles('xlsx', workbook, [['xl/_rels/workbook.xml.rels', relationships(relElements.join(''))], ...worksheetParts])), { kind: 'xlsx' });
  assert.equal(result.units.length, count);
  assert.equal(result.metadata.sheets_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.metadata)) < 12300);
  assert.ok(result.metadata.sheets.reduce((sum, sheet) => sum + sheet.merged_cells.length, 0) <= 128);
  assert.match(result.warnings.join('\n'), /metadata reached|Merged-cell metadata/);
});

test('Office extraction splits long units without broken Unicode and reports truncation', async () => {
  const value = '😀'.repeat(60000);
  const bytes = zip(packageFiles('docx', wordDoc(paragraph(value) + paragraph('第二段'))));
  const complete = await extractOffice(bytes, { kind: 'docx' });
  assert.equal(complete.units.length, 3);
  assert.equal(complete.units[0].text + complete.units[1].text, value);
  assert.equal(complete.units[0].locator.segment, 1);
  assert.ok(complete.units.every(unit => unit.text.length <= 100000 && !unit.text.includes('\uFFFD')));
  const limited = await extractOffice(bytes, { kind: 'docx', max_units: 1 });
  assert.equal(limited.units.length, 1);
  assert.equal(limited.truncated, true);
  assert.match(limited.warnings.join('\n'), /incomplete/);
});

test('Legacy DOC/PPT require explicitly configured converter and valid original file signature', async () => {
  const legacy = Buffer.from('d0cf11e0a1b11ae1', 'hex');
  await assert.rejects(extractOffice(legacy, { kind: 'doc', libreoffice: '' }), /requires LibreOffice/);
  await assert.rejects(extractOffice(legacy, { kind: 'ppt', libreoffice: 'soffice' }), /absolute executable path/);
  await assert.rejects(extractOffice(Buffer.from('hello'), { kind: 'doc', libreoffice: process.execPath }), /expected an OLE Office/);
  await assert.rejects(extractOffice(Buffer.alloc(MAX_SOURCE_BYTES + 1), { kind: 'docx' }), new RegExp(`${MAX_SOURCE_MIB} MiB`));
});

test('LibreOffice round-trips real DOC and PPT with Chinese text', { skip: configuredConverter() ? false : 'set PROJECT_WIKI_LIBREOFFICE_TEST to an existing absolute soffice executable path to run this' }, async () => {
  const command = configuredConverter();
  assert.equal(path.isAbsolute(command), true);
  const tempParent = await realpath(os.tmpdir());
  const temporary = await mkdtemp(path.join(tempParent, 'project-wiki-office-test-'));
  try {
    await mkdir(path.join(temporary, 'output'));
    const namespaces = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';
    const word = `<?xml version="1.0" encoding="UTF-8"?><office:document ${namespaces} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.text"><office:body><office:text><text:p>旧版Word中文验证</text:p><text:p>Office legacy extraction test</text:p></office:text></office:body></office:document>`;
    const presentation = `<?xml version="1.0" encoding="UTF-8"?><office:document ${namespaces} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.presentation"><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="21cm" style:print-orientation="landscape"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles><office:body><office:presentation><draw:page draw:name="page1" draw:master-page-name="Default"><draw:frame svg:width="20cm" svg:height="5cm" svg:x="2cm" svg:y="2cm"><draw:text-box><text:p>旧版PPT中文验证</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document>`;
    for (const [sourceKind, targetKind, filter, contents, expected] of [
      ['fodt', 'doc', 'MS Word 97', word, '旧版Word中文验证'],
      ['fodp', 'ppt', 'MS PowerPoint 97', presentation, '旧版PPT中文验证'],
    ]) {
      const original = path.join(temporary, `fixture.${sourceKind}`);
      await writeFile(original, contents, { flag: 'wx' });
      await promisify(execFile)(command, [`-env:UserInstallation=${pathToFileURL(path.join(temporary, 'fixture-profile')).href}`, '--headless', '--nologo', '--norestore', '--convert-to', `${targetKind}:${filter}`, '--outdir', path.join(temporary, 'output'), original], { windowsHide: true, shell: false, timeout: 45000, maxBuffer: 1024 * 1024 });
      const bytes = await readFile(path.join(temporary, 'output', `fixture.${targetKind}`));
      assert.equal(bytes.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1');
      const result = await extractOffice(bytes, { kind: targetKind, libreoffice: command });
      assert.equal(result.format, targetKind);
      assert.equal(result.metadata.converter, 'LibreOffice');
      assert.ok(result.units.some(unit => unit.text.includes(expected)));
    }
  } finally {
    const resolved = await realpath(temporary);
    assert.equal(path.dirname(resolved), tempParent);
    assert.ok(path.basename(resolved).startsWith('project-wiki-office-test-'));
    await rm(resolved, { recursive: true, force: true });
  }
});

// Guards the CI regression where PROJECT_WIKI_LIBREOFFICE_TEST was pointed at the Linux path
// '/usr/bin/soffice' on a Windows runner: path.isAbsolute() accepts it, so the opt-in test
// above stopped skipping and failed on exec instead. The converter must be required to exist.
test('a preset LibreOffice path that does not exist is not treated as a usable converter', async () => {
  const previous = process.env.PROJECT_WIKI_LIBREOFFICE_TEST;
  process.env.PROJECT_WIKI_LIBREOFFICE_TEST = path.join(os.tmpdir(), 'project-wiki-absent-soffice-does-not-exist');
  try {
    assert.equal(configuredConverter(), undefined);
  } finally {
    if (previous === undefined) delete process.env.PROJECT_WIKI_LIBREOFFICE_TEST;
    else process.env.PROJECT_WIKI_LIBREOFFICE_TEST = previous;
  }
});
