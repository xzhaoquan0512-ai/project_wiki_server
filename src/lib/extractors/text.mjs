import { MAX_SOURCE_BYTES as MAX_BYTES, MAX_SOURCE_MIB } from '../source-limits.mjs';
import iconv from 'iconv-lite';


function normalizeEncoding(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_.:-]{1,64}$/i.test(value.trim())) throw new Error('Invalid text encoding name.');
  const name = value.trim().toLowerCase().replace(/[-_:]/g, '');
  const aliases = { utf8: 'utf-8', utf16le: 'utf-16le', ucs2: 'utf-16le', ucs2le: 'utf-16le', utf16be: 'utf-16be', ucs2be: 'utf-16be', utf16: 'utf-16', cp936: 'gbk', gb2312: 'gbk', gb18030: 'gb18030', gbk: 'gbk' };
  return aliases[name] ?? value.trim().toLowerCase();
}

function declaration(text) {
  const sample = text.slice(0, 16384).replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const xml = /^\s*<\?xml\s[^?]*\bencoding\s*=\s*(['"])([^'"]+)\1/i.exec(sample);
  if (xml) return normalizeEncoding(xml[2]);
  for (const match of sample.matchAll(/<meta\s[^>]*>/gi)) {
    const attributes = new Map();
    for (const attribute of match[0].slice(5, -1).matchAll(/([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = attribute[1].toLowerCase();
      if (!attributes.has(name)) attributes.set(name, attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    if (attributes.has('charset')) return normalizeEncoding(attributes.get('charset'));
    if (attributes.get('http-equiv')?.toLowerCase() === 'content-type' && attributes.has('content')) {
      const charset = /\bcharset\s*=\s*([\w.:-]+)/i.exec(attributes.get('content'));
      if (charset) return normalizeEncoding(charset[1]);
    }
  }
  return undefined;
}

/** Decode bytes only from explicit metadata or strict UTF-8; never guess a legacy encoding. */
export function decodeText(value, { encoding } = {}) {
  if (!(value instanceof Uint8Array)) throw new Error('Text input must be bytes.');
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.length > MAX_BYTES) throw new Error(`Text source exceeds the ${MAX_SOURCE_MIB} MiB size limit.`);
  let bom, skip = 0;
  if (bytes.length >= 4 && ((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) || (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff))) {
    throw new Error('UTF-32 is unsupported; convert a copy to UTF-8 before importing.');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { bom = 'utf-8'; skip = 3; }
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { bom = 'utf-16le'; skip = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { bom = 'utf-16be'; skip = 2; }
  const explicit = encoding === undefined ? undefined : normalizeEncoding(encoding);
  if (explicit && bom && explicit !== bom && !(explicit === 'utf-16' && bom.startsWith('utf-16'))) throw new Error(`Explicit encoding ${explicit} conflicts with the ${bom} byte-order mark.`);
  const declared = bom ? undefined : declaration(bytes.subarray(0, 16384).toString('latin1'));
  let chosen = explicit ?? bom ?? declared ?? 'utf-8';
  if (chosen === 'utf-16') {
    if (!bom?.startsWith('utf-16')) throw new Error('UTF-16 needs a byte-order mark or explicit utf-16le / utf-16be encoding.');
    chosen = bom;
  }
  if (!iconv.encodingExists(chosen)) throw new Error(`Unsupported text encoding: ${chosen}.`);
  const warnings = [];
  if (explicit && declared && explicit !== declared) warnings.push(`Explicit encoding ${explicit} overrides the document declaration ${declared}.`);
  let text;
  try {
    if (['utf-8', 'utf-16le', 'utf-16be'].includes(chosen)) text = new TextDecoder(chosen, { fatal: true }).decode(bytes.subarray(skip));
    else {
      text = iconv.decode(bytes.subarray(skip), chosen, { stripBOM: true });
      if (text.includes('\ufffd')) throw new Error('undecodable byte sequence');
    }
  } catch {
    throw new Error(`Source is not valid ${chosen}. Supply the original text encoding explicitly (for example gb18030), or convert a copy to UTF-8.`);
  }
  if (text.includes('\0')) throw new Error('Decoded text contains NUL bytes; this is a binary source or the wrong encoding.');
  const finalDeclared = declaration(text);
  if (bom && finalDeclared && finalDeclared !== bom && !(finalDeclared === 'utf-16' && bom.startsWith('utf-16'))) warnings.push(`The ${bom} byte-order mark overrides the document declaration ${finalDeclared}.`);
  return { text, encoding: chosen, encoding_source: explicit ? 'explicit' : bom ? 'bom' : declared ? 'declaration' : 'strict_utf8', warnings };
}
