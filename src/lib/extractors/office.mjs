import { MAX_SOURCE_BYTES as MAX_SOURCE, MAX_SOURCE_MIB } from '../source-limits.mjs';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, lstat, realpath, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';

const execute = promisify(execFile);
const MAX_PART = 10 * 1024 * 1024;
const MAX_EXPANDED = 100 * 1024 * 1024;
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_UNIT = 100000;
const MAX_UNITS = 10000;
const MAX_ENTRIES = 5000;
const OFFICE_FORMATS = new Set(['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt']);

function resultSink(format, maximum) {
  const result = { format, units: [], warnings: [], metadata: {}, truncated: false };
  let textBytes = 0;
  const maxUnits = maximum === undefined ? MAX_UNITS : maximum;
  if (!Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > MAX_UNITS) throw new Error(`max_units must be between 1 and ${MAX_UNITS}.`);
  return {
    result,
    warn(message) { if (!result.warnings.includes(message)) result.warnings.push(message); },
    add(locator, original) {
      const value = String(original ?? '').replace(/\r\n?/g, '\n').trim();
      if (!value) return;
      let offset = 0, segment = 0;
      while (offset < value.length) {
        if (result.units.length >= maxUnits || textBytes >= MAX_TEXT) { result.truncated = true; break; }
        let chunk = value.slice(offset, offset + MAX_UNIT);
        // Do not split a surrogate pair at the unit boundary.
        if (/[\uD800-\uDBFF]$/.test(chunk)) chunk = chunk.slice(0, -1);
        let count = Buffer.byteLength(chunk);
        if (textBytes + count > MAX_TEXT) {
          chunk = Buffer.from(chunk).subarray(0, MAX_TEXT - textBytes).toString('utf8').replace(/\uFFFD$/u, '');
          count = Buffer.byteLength(chunk);
          result.truncated = true;
        }
        if (!chunk) break;
        result.units.push({ locator: { ...locator, ...(value.length > MAX_UNIT ? { segment: ++segment } : {}) }, text: chunk });
        textBytes += count;
        offset += chunk.length;
      }
      if (offset < value.length) result.truncated = true;
    },
    finish() {
      result.metadata.extracted_text_bytes = textBytes;
      if (result.truncated) this.warn('Extraction reached the bounded text/unit limit; the result is incomplete.');
      if (!result.units.length) this.warn('No extractable Office text was found. Image-only content requires separate OCR.');
      return result;
    },
  };
}

function parseXml(bytes, part) {
  // OpenXML normally uses UTF-8. UTF-16 BOMs are also permitted by the standard.
  const bigEndian = bytes[0] === 0xfe && bytes[1] === 0xff;
  const littleEndian = bytes[0] === 0xff && bytes[1] === 0xfe;
  const encoding = bigEndian ? 'utf-16be' : littleEndian ? 'utf-16le' : 'utf-8';
  const xml = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const document = { name: '#document', children: [], attrs: Object.create(null), text: '' };
  const stack = [document];
  let nodes = 0;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => { throw new Error(`DTD/entity declarations are not allowed in Office XML: ${part}`); });
  parser.on('opentag', tag => {
    if (++nodes > 150000 || stack.length > 128) throw new Error(`Office XML structure exceeds the node/depth limit: ${part}`);
    const node = { name: tag.name.split(':').at(-1), attrs: tag.attributes, children: [], text: '' };
    stack.at(-1).children.push(node);
    stack.push(node);
  });
  parser.on('closetag', () => stack.pop());
  const append = value => { stack.at(-1).text += value; };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.write(xml).close();
  return document;
}

function descendants(node, name) {
  const found = [];
  function visit(current) {
    if (current.name === name) found.push(current);
    for (const child of current.children) visit(child);
  }
  visit(node);
  return found;
}

function direct(node, name) { return node?.children.filter(child => child.name === name) ?? []; }
function first(node, name) { return descendants(node, name)[0]; }
function texts(node) { return descendants(node, 't').map(child => child.text).join(''); }
function attr(node, key) { return node?.attrs[key] ?? Object.entries(node?.attrs ?? {}).find(([name]) => name.split(':').at(-1) === key)?.[1]; }
function relationshipId(node) { return Object.entries(node?.attrs ?? {}).find(([name]) => name.endsWith(':id'))?.[1]; }

async function packageParts(bytes, format, sink) {
  if (bytes.length > MAX_SOURCE) throw new Error(`Office source exceeds the ${MAX_SOURCE_MIB} MiB size limit.`);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`Invalid or encrypted ${format.toUpperCase()} file: expected an OpenXML ZIP package.`);
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, file) => error ? reject(error) : resolve(file)));
  const parts = new Map();
  const names = new Set();
  let expanded = 0, entries = 0;
  const allowed = format === 'docx'
    ? /^(?:word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml|word\/_rels\/document\.xml\.rels)$/
    : format === 'xlsx'
      ? /^xl\/(?:workbook\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml|_rels\/workbook\.xml\.rels)$/
      : /^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/[^/]+\.xml|slides\/_rels\/[^/]+\.xml\.rels|notesSlides\/[^/]+\.xml)$/;
  await new Promise((resolve, reject) => {
    let failed = false;
    const fail = error => { if (!failed) { failed = true; zip.close(); reject(error); } };
    zip.on('error', fail);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      (async () => {
        if (++entries > MAX_ENTRIES) throw new Error(`Office package exceeds ${MAX_ENTRIES} entries.`);
        if (entry.fileName.length > 256) throw new Error('Office package part name exceeds the 256-character limit.');
        if (names.has(entry.fileName)) throw new Error('Duplicate Office package part names are not allowed.');
        names.add(entry.fileName);
        if (entry.generalPurposeBitFlag & 1) throw new Error('Encrypted Office package entries are not supported.');
        if (entry.uncompressedSize > MAX_PART) throw new Error('Office package part exceeds the 10 MiB limit.');
        expanded += entry.uncompressedSize;
        if (expanded > MAX_EXPANDED) throw new Error('Office package exceeds the 100 MiB expanded size limit.');
        if (/(?:vbaProject|embeddings\/|activeX\/)/i.test(entry.fileName)) sink.warn('Macros, embedded objects and active content are not executed or extracted.');
        if (allowed.test(entry.fileName)) {
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (error, input) => error ? rej(error) : res(input)));
          const chunks = []; let length = 0;
          for await (const chunk of stream) {
            length += chunk.length;
            if (length > MAX_PART) { stream.destroy(); throw new Error('Office package part exceeds the expanded size limit.'); }
            chunks.push(chunk);
          }
          parts.set(entry.fileName, Buffer.concat(chunks));
        }
        if (!failed) zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
  sink.result.metadata.package_entries = entries;
  return parts;
}

function xmlPart(parts, name, required = false) {
  const bytes = parts.get(name);
  if (!bytes && required) throw new Error(`Office package is missing required part: ${name}`);
  return bytes ? parseXml(bytes, name) : undefined;
}

function relationships(parts, relsPath, basePath, sink) {
  const tree = xmlPart(parts, relsPath);
  const output = new Map();
  if (!tree) return output;
  for (const item of descendants(tree, 'Relationship')) {
    const id = attr(item, 'Id'), target = attr(item, 'Target') ?? '', type = attr(item, 'Type') ?? '';
    if (!id || id.length > 128 || target.length > 512 || type.length > 2048) throw new Error('Office relationship exceeds identifier/target limits.');
    if (attr(item, 'TargetMode') === 'External' || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) {
      sink.warn('External Office links are retained only as document text; their targets are never fetched.');
      continue;
    }
    if (!id || /[\\\0]/.test(target)) throw new Error('Invalid Office relationship target.');
    const resolved = target.startsWith('/') ? path.posix.normalize(target.slice(1)) : path.posix.normalize(path.posix.join(path.posix.dirname(basePath), target));
    if (resolved.startsWith('../') || resolved === '..') throw new Error('Office relationship escapes its package.');
    if (output.has(id)) throw new Error('Duplicate Office relationship identifiers.');
    output.set(id, { target: resolved, type });
  }
  return output;
}

function paragraphText(node) {
  const pieces = [];
  function visit(current) {
    if (current.name === 'del' || current.name === 'instrText') return;
    if (current.name === 't') pieces.push(current.text);
    else if (current.name === 'tab') pieces.push('\t');
    else if (current.name === 'br' || current.name === 'cr') pieces.push('\n');
    else for (const child of current.children) visit(child);
  }
  visit(node);
  return pieces.join('');
}

function tableText(node) {
  return direct(node, 'tr').map(row => direct(row, 'tc').map(cell => descendants(cell, 'p').map(paragraphText).join(' / ')).join('\t')).join('\n');
}

function extractDocx(parts, sink) {
  const bodyPart = 'word/document.xml';
  if (!parts.has(bodyPart)) throw new Error(`Office package is missing required part: ${bodyPart}`);
  const rels = relationships(parts, 'word/_rels/document.xml.rels', bodyPart, sink);
  const partNames = [bodyPart, ...[...rels.values()].filter(item => /\/(?:header|footer|footnotes|endnotes|comments)$/.test(item.type)).map(item => item.target)];
  for (const name of [...new Set(partNames)]) {
    const root = xmlPart(parts, name, true);
    let paragraph = 0, table = 0;
    function visit(node) {
      if (node.name === 'p') sink.add({ kind: 'paragraph', part: name, paragraph: ++paragraph }, paragraphText(node));
      else if (node.name === 'tbl') sink.add({ kind: 'table', part: name, table: ++table }, tableText(node));
      else if (node.name !== 'del') for (const child of node.children) visit(child);
    }
    visit(root);
  }
  sink.warn('Word paragraph/table order is preserved; page layout, images, equations and embedded objects are not rendered.');
}

function spreadsheetRow(cells) { return cells.map(cell => `${cell.address}: ${cell.formula === undefined ? '' : `=${cell.formula} [cached: `}${cell.value}${cell.formula === undefined ? '' : ']'}`).join('\t'); }

function checkedSheetName(value) {
  const name = String(value ?? '');
  if (!name || [...name].length > 31 || /[\\/?*\[\]:\x00-\x1f]/.test(name)) throw new Error('Invalid worksheet name: expected 1-31 characters without reserved characters.');
  return name;
}

function checkedCellAddress(value) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value ?? '');
  if (!match) throw new Error('Invalid worksheet cell coordinate.');
  let column = 0;
  for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16384 || row > 1048576) throw new Error('Worksheet coordinate exceeds Excel row/column limits.');
  return { column, row };
}

function checkedMergeRange(value) {
  const pieces = String(value ?? '').split(':');
  if (pieces.length !== 2) throw new Error('Invalid merged worksheet range.');
  const start = checkedCellAddress(pieces[0]), end = checkedCellAddress(pieces[1]);
  if (start.column > end.column || start.row > end.row) throw new Error('Reversed merged worksheet range.');
  return value;
}

function sheetMetadata(sink, item) {
  const metadata = sink.result.metadata;
  metadata.sheets ??= [];
  if (metadata.sheets_truncated) return;
  if (Buffer.byteLength(JSON.stringify({ ...metadata, sheets: [...metadata.sheets, item] })) > 12000) {
    metadata.sheets_truncated = true;
    sink.warn('Worksheet metadata reached the 12 KiB limit; additional worksheet metadata is omitted, while text extraction continues.');
    return;
  }
  metadata.sheets.push(item);
}

function addSheet(sink, sheet, sheetIndex, rows, extra = {}) {
  let lines = [], length = 0, start, end;
  const flush = () => {
    if (!lines.length) return;
    sink.add({ kind: 'sheet', sheet, sheet_index: sheetIndex, row_start: start, row_end: end, ...extra }, lines.join('\n'));
    lines = []; length = 0;
  };
  for (const row of rows) {
    const line = spreadsheetRow(row.cells);
    if (!line) continue;
    if (lines.length >= 200 || length + line.length > 80000) flush();
    if (!lines.length) start = row.row;
    lines.push(line); length += line.length + 1; end = row.row;
  }
  flush();
}

function extractXlsx(parts, sink) {
  const workbook = xmlPart(parts, 'xl/workbook.xml', true);
  const rels = relationships(parts, 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', sink);
  const shared = xmlPart(parts, 'xl/sharedStrings.xml');
  const strings = shared ? descendants(shared, 'si').map(texts) : [];
  const sheets = descendants(workbook, 'sheet');
  sink.result.metadata.sheets = [];
  const names = new Set();
  let remainingMergeMetadata = 128;
  for (const [index, sheet] of sheets.entries()) {
    const name = checkedSheetName(attr(sheet, 'name'));
    if (names.has(name.toLocaleLowerCase('en-US'))) throw new Error('Duplicate worksheet names are not allowed.');
    names.add(name.toLocaleLowerCase('en-US'));
    const state = attr(sheet, 'state') ?? 'visible';
    if (!['visible', 'hidden', 'veryHidden'].includes(state)) throw new Error('Invalid worksheet visibility state.');
    const rel = rels.get(relationshipId(sheet));
    if (!rel || !/\/worksheet$/.test(rel.type) || !/^xl\/worksheets\/[^/]+\.xml$/.test(rel.target)) throw new Error(`Missing or invalid worksheet relationship for ${name}.`);
    const xml = xmlPart(parts, rel.target, true);
    const rows = descendants(xml, 'row').map((row, rowIndex) => {
      const rowNumber = attr(row, 'r') === undefined ? rowIndex + 1 : Number(attr(row, 'r'));
      if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 1048576) throw new Error('Invalid worksheet row index.');
      return { row: rowNumber, cells: direct(row, 'c').map(cell => {
      const address = attr(cell, 'r') ?? '?';
      if (address !== '?') checkedCellAddress(address);
      const type = attr(cell, 't');
      const raw = first(cell, 'v')?.text ?? '';
      const formula = first(cell, 'f');
      let value = raw;
      if (type === 's') {
        if (!/^\d+$/.test(raw) || Number(raw) >= strings.length) throw new Error('Invalid worksheet shared string index.');
        value = strings[Number(raw)];
      } else if (type === 'inlineStr') value = texts(cell);
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      return { address, value, ...(formula ? { formula: formula.text || `[shared formula ${attr(formula, 'si') ?? '?'}]` } : {}) };
    }) };
    });
    const merges = descendants(xml, 'mergeCell').map(item => checkedMergeRange(attr(item, 'ref')));
    const keptMerges = merges.slice(0, Math.min(32, remainingMergeMetadata));
    remainingMergeMetadata -= keptMerges.length;
    sheetMetadata(sink, { name, index: index + 1, state, merged_cells: keptMerges, merged_cells_truncated: merges.length > keptMerges.length });
    if (merges.length > keptMerges.length) sink.warn('Merged-cell metadata is limited to 32 ranges per worksheet and 128 ranges per workbook; text extraction continues.');
    addSheet(sink, name, index + 1, rows, { part: rel.target });
  }
  sink.warn('Spreadsheet formulas are not executed; cached values may be stale. Numeric/date cells retain stored values, not visual formatting.');
}

function slideText(root) {
  const text = [];
  function visit(node) {
    if (node.name === 'tbl') text.push(tableText(node));
    else if (node.name === 'p') text.push(paragraphText(node));
    else for (const child of node.children) visit(child);
  }
  visit(root);
  return text.filter(Boolean).join('\n');
}

function extractPptx(parts, sink) {
  const presentation = xmlPart(parts, 'ppt/presentation.xml', true);
  const rels = relationships(parts, 'ppt/_rels/presentation.xml.rels', 'ppt/presentation.xml', sink);
  const slides = descendants(presentation, 'sldId');
  sink.result.metadata.slides = slides.length;
  for (const [index, slide] of slides.entries()) {
    const rel = rels.get(relationshipId(slide));
    if (!rel || !/\/slide$/.test(rel.type) || !/^ppt\/slides\/[^/]+\.xml$/.test(rel.target)) throw new Error(`Missing or invalid slide relationship for slide ${index + 1}.`);
    const xml = xmlPart(parts, rel.target, true);
    sink.add({ kind: 'slide', slide: index + 1, part: rel.target, section: 'content' }, slideText(xml));
    const notesRels = relationships(parts, `ppt/slides/_rels/${path.posix.basename(rel.target)}.rels`, rel.target, sink);
    for (const notes of notesRels.values()) {
      if (!/\/notesSlide$/.test(notes.type)) continue;
      if (!/^ppt\/notesSlides\/[^/]+\.xml$/.test(notes.target)) throw new Error('Invalid PowerPoint notes relationship.');
      sink.add({ kind: 'slide', slide: index + 1, part: notes.target, section: 'notes' }, slideText(xmlPart(parts, notes.target, true)));
    }
  }
  sink.warn('Slide text, tables and speaker notes are extracted in presentation order; charts, images and visual layout are not rendered.');
}

async function extractXls(bytes, sink) {
  if (bytes.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1') throw new Error('Invalid XLS source: expected a binary OLE workbook. Save old BIFF-only files as XLSX first.');
  const { default: XLSX } = await import('xlsx');
  const workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: true, cellHTML: false, cellNF: false, cellStyles: false, cellText: false, bookVBA: false, sheetRows: 10000, WTF: true });
  sink.result.metadata.sheets = [];
  for (const [index, name] of workbook.SheetNames.entries()) {
    checkedSheetName(name);
    const sheet = workbook.Sheets[name];
    const rows = new Map();
    for (const [address, cell] of Object.entries(sheet)) {
      if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) continue;
      const row = Number(address.match(/\d+$/)[0]);
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row).push({ address, value: String(cell.v ?? ''), ...(cell.f === undefined ? {} : { formula: cell.f }) });
    }
    const orderedRows = [...rows].sort(([a], [b]) => a - b).map(([row, cells]) => ({ row, cells: cells.sort((a, b) => XLSX.utils.decode_cell(a.address).c - XLSX.utils.decode_cell(b.address).c) }));
    addSheet(sink, name, index + 1, orderedRows);
    sheetMetadata(sink, { name, index: index + 1, state: workbook.Workbook?.Sheets?.[index]?.Hidden ? 'hidden' : 'visible' });
    if (sheet['!fullref'] && sheet['!fullref'] !== sheet['!ref']) sink.result.truncated = true;
  }
  sink.warn('Legacy XLS formulas/macros are not executed; cached values may be stale. At most the first 10000 rows per worksheet are read.');
}

async function convertLegacy(bytes, format, options) {
  const command = options.libreoffice ?? process.env.PROJECT_WIKI_LIBREOFFICE;
  if (!command) throw new Error(`Legacy .${format} extraction requires LibreOffice. Install LibreOffice and set PROJECT_WIKI_LIBREOFFICE to its soffice executable; or save the file as .${format}x.`);
  if (typeof command !== 'string' || !path.isAbsolute(command)) throw new Error('PROJECT_WIKI_LIBREOFFICE must be an absolute executable path configured by the operator.');
  if (bytes.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1') throw new Error(`Invalid .${format} source: expected an OLE Office file.`);
  const parent = await realpath(os.tmpdir());
  const temp = await mkdtemp(path.join(parent, 'project-wiki-office-'));
  const targetFormat = format === 'doc' ? 'docx' : 'pptx';
  try {
    const profile = path.join(temp, 'profile');
    await mkdir(path.join(profile, 'user'), { recursive: true });
    await mkdir(path.join(temp, 'output'));
    // The isolated profile does not inherit trusted locations, macros or extensions.
    // Explicitly disable scripts, OLE/DDE and document link/field updates.
    const settings = `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop><prop oor:name="Field" oor:op="fuse"><value>false</value></prop><prop oor:name="Chart" oor:op="fuse"><value>false</value></prop></item></oor:items>`;
    await writeFile(path.join(profile, 'user', 'registrymodifications.xcu'), settings, { flag: 'wx', mode: 0o600 });
    const input = path.join(temp, `source.${format}`);
    await writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
    const filter = format === 'doc' ? 'docx:Office Open XML Text' : 'pptx:Impress MS PowerPoint 2007 XML';
    try {
      await runConverter(command, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', filter, '--outdir', path.join(temp, 'output'), input], temp);
    } catch (error) {
      throw new Error(`LibreOffice ${format} conversion failed${error.killed ? ' or timed out after 45 seconds' : ''}: ${error.code ?? error.message}`);
    }
    const output = path.join(temp, 'output', `source.${targetFormat}`);
    let info;
    try { info = await lstat(output); } catch { throw new Error(`LibreOffice did not produce a ${targetFormat} file. The source may be damaged or encrypted.`); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SOURCE || path.dirname(await realpath(output)) !== path.join(await realpath(temp), 'output')) throw new Error('Converted Office file is unsafe or exceeds the source size limit.');
    const converted = await readFile(output);
    const result = await extractOffice(converted, { ...options, kind: targetFormat });
    result.format = format;
    result.metadata.converted_from = format;
    result.metadata.converter = 'LibreOffice';
    result.warnings.push('Legacy Office was converted in an isolated LibreOffice profile with macros, active content and link updates disabled. Conversion can alter layout and omit unsupported elements.');
    return result;
  } finally {
    const resolved = await realpath(temp);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('project-wiki-office-')) throw new Error('Refusing to remove an unexpected Office temporary directory.');
    await rm(resolved, { recursive: true, force: true });
  }
}

function runConverter(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let stopped = false, outputBytes = 0;
    const stop = async reason => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      // Kill only this conversion process tree; its isolated profile prevents reuse of a user's open instance.
      if (child.pid) {
        if (process.platform === 'win32') {
          await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 65536 }).catch(() => child.kill('SIGKILL'));
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }
      reject(reason);
    };
    const timer = setTimeout(() => stop(Object.assign(new Error('conversion timeout'), { killed: true })), 45000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) void stop(new Error('conversion output exceeded 1 MiB'));
    });
    child.once('error', error => { if (!stopped) { stopped = true; clearTimeout(timer); reject(error); } });
    child.once('close', code => {
      if (stopped) return;
      stopped = true; clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`conversion exit code ${code}`), { code }));
    });
  });
}

/** Extract only local Office bytes. No URLs, macros, formulas or shell commands from documents are executed. */
export async function extractOffice(input, options = {}) {
  const bytes = Buffer.from(input);
  if (bytes.length > MAX_SOURCE) throw new Error(`Office source exceeds the ${MAX_SOURCE_MIB} MiB size limit.`);
  const format = String(options.kind ?? path.extname(options.filename ?? '').slice(1)).toLowerCase();
  if (!OFFICE_FORMATS.has(format)) throw new Error(`Unsupported Office format: ${format || '(unknown)'}`);
  if (format === 'doc' || format === 'ppt') return convertLegacy(bytes, format, options);
  const sink = resultSink(format, options.max_units);
  if (format === 'xls') await extractXls(bytes, sink);
  else {
    const parts = await packageParts(bytes, format, sink);
    if (format === 'docx') extractDocx(parts, sink);
    if (format === 'xlsx') extractXlsx(parts, sink);
    if (format === 'pptx') extractPptx(parts, sink);
  }
  return sink.finish();
}
