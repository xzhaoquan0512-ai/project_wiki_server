import { parse } from 'parse5';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { decodeText } from './text.mjs';

const MAX_DEPTH = 128;
const MAX_NODES = 100000;
const MAX_UNITS = 10000;
const MAX_UNIT_CHARS = 100000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SKIP_HTML = new Set(['script', 'style', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'input', 'select', 'option', 'textarea', 'template', 'iframe', 'object', 'embed', 'canvas', 'svg', 'noscript']);
const BLOCK_HTML = new Set(['html', 'head', 'body', 'main', 'article', 'section', 'div', 'address', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'pre', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'details', 'summary', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'hr']);
const ATOMIC_HTML = new Set(['title', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'pre', 'li', 'dt', 'dd', 'figcaption', 'summary', 'caption']);

function boundedOutput(format, warnings, metadata) {
  const units = [];
  let outputBytes = 0, truncated = false;
  // Record which limit cut content. Omitted units carry no marker of their own, so the reason must be explicit.
  const warn = reason => { if (!truncated) warnings.push(reason); truncated = true; };
  return {
    add(locator, raw) {
      if (locator.path.length > 4096) throw new Error('Markup node path exceeds the 4096-character safety limit.');
      let text = raw.trim();
      if (!text) return;
      if (units.length >= MAX_UNITS || outputBytes >= MAX_OUTPUT_BYTES) {
        warn(units.length >= MAX_UNITS
          ? `Extraction reached the ${MAX_UNITS}-unit limit; later content was omitted.`
          : `Extraction reached the ${MAX_OUTPUT_BYTES}-byte output limit; later content was omitted.`);
        return;
      }
      const truncations = [];
      if (text.length > MAX_UNIT_CHARS) {
        text = text.slice(0, MAX_UNIT_CHARS); if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
        truncations.push(`unit text was cut to ${MAX_UNIT_CHARS} characters`);
      }
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (Buffer.byteLength(text, 'utf8') > remaining) {
        text = Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8').replace(/\ufffd$/, '');
        truncations.push(`unit text was cut to the remaining ${remaining} bytes of the total output limit`);
      }
      if (truncations.length) {
        // The unit keeps its own marker so a reader cannot mistake cut evidence for the whole node.
        const reason = `Extraction truncated this unit: ${truncations.join('; ')}.`;
        locator.truncated = true; locator.truncation_reason = reason;
        warn(`Extraction truncated content by the per-unit or total output limit; affected units carry truncated: true in their locator.`);
      }
      if (text) { units.push({ locator, text }); outputBytes += Buffer.byteLength(text, 'utf8'); }
    },
    result() { return { format, units, warnings, metadata: { ...metadata, truncated, output_bytes: outputBytes, limits: { max_depth: MAX_DEPTH, max_nodes: MAX_NODES, max_units: MAX_UNITS, max_unit_chars: MAX_UNIT_CHARS, max_output_bytes: MAX_OUTPUT_BYTES } } }; },
  };
}

function htmlHidden(node) {
  if (SKIP_HTML.has(node.tagName)) return true;
  const attributes = Object.fromEntries((node.attrs ?? []).map(item => [item.name, item.value]));
  return Object.hasOwn(attributes, 'hidden') || attributes['aria-hidden'] === 'true' || /^(navigation|banner|contentinfo|complementary|menu)$/i.test(attributes.role ?? '') || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attributes.style ?? '');
}

function htmlText(node, pre = false) {
  if (htmlHidden(node)) return '';
  if (node.nodeName === '#text') return pre ? node.value : node.value.replace(/\s+/g, ' ');
  if (node.nodeName === '#comment') return '';
  if (node.tagName === 'br') return '\n';
  if (node.tagName === 'img') return (node.attrs ?? []).find(item => item.name === 'alt')?.value ?? '';
  let value = (node.childNodes ?? []).map(child => {
    const part = htmlText(child, pre);
    return BLOCK_HTML.has(child.tagName) ? `\n${part}\n` : part;
  }).join('');
  if (node.tagName === 'li') value = `- ${value.trim()}`;
  return pre ? value : value.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function extractHtml(text, decoded) {
  // Bound the parser's allocation even when most elements will later be filtered.
  if ((text.match(/</g)?.length ?? 0) > MAX_NODES * 2) throw new Error('HTML exceeds the 100000-node parsing limit.');
  const document = parse(text, { scriptingEnabled: false, sourceCodeLocationInfo: true });
  const paths = new WeakMap(), pending = [{ node: document, path: '', depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { node, path, depth } = pending.pop();
    if (++nodes > MAX_NODES) throw new Error('HTML exceeds the 100000-node parsing limit.');
    if (depth > MAX_DEPTH) throw new Error('HTML exceeds the 128-level nesting limit.');
    paths.set(node, path);
    const counters = new Map();
    for (const child of node.childNodes ?? []) {
      const name = child.tagName ?? (child.nodeName === '#text' ? 'text()' : child.nodeName);
      const count = (counters.get(name) ?? 0) + 1; counters.set(name, count);
      pending.push({ node: child, path: `${path}/${name}[${count}]`, depth: depth + 1 });
    }
  }
  const warnings = [...decoded.warnings, 'HTML is parsed as inert local data. Navigation, scripts, styles, forms, and hidden elements are omitted; external resources and CSS layout are not loaded.'];
  const output = boundedOutput('html', warnings, { encoding: decoded.encoding, encoding_source: decoded.encoding_source, parsed_nodes: nodes });
  const locator = node => ({ kind: 'html_node', path: paths.get(node) || '/', ...(node.sourceCodeLocation?.startLine ? { line: node.sourceCodeLocation.startLine } : {}) });
  function visit(node) {
    if (htmlHidden(node) || node.nodeName === '#comment') return;
    if (node.tagName === 'head') { for (const child of node.childNodes ?? []) if (child.tagName === 'title') visit(child); return; }
    if (node.tagName === 'tr') {
      output.add(locator(node), (node.childNodes ?? []).filter(child => ['td', 'th'].includes(child.tagName) && !htmlHidden(child)).map(child => htmlText(child).trim().replace(/\n+/g, ' / ')).join(' | '));
      return;
    }
    if (ATOMIC_HTML.has(node.tagName)) { output.add(locator(node), htmlText(node, node.tagName === 'pre')); return; }
    let inline = '', first;
    const flush = () => { if (inline.trim()) output.add(locator(first ?? node), inline); inline = ''; first = undefined; };
    for (const child of node.childNodes ?? []) {
      if (BLOCK_HTML.has(child.tagName)) { flush(); visit(child); }
      else { first ??= child; inline += htmlText(child); }
    }
    flush();
  }
  visit(document);
  return output.result();
}

// Lex before parsing: no DTDs or custom entities, bounded nesting/node counts.
function checkXml(text) {
  let offset = 0, depth = 0, nodes = 0;
  while ((offset = text.indexOf('<', offset)) !== -1) {
    if (text.startsWith('<!--', offset) || text.startsWith('<![CDATA[', offset) || text.startsWith('<?', offset)) {
      const marker = text.startsWith('<!--', offset) ? '-->' : text.startsWith('<?', offset) ? '?>' : ']]>';
      const end = text.indexOf(marker, offset + 2);
      if (end === -1) throw new Error('Malformed XML: unterminated comment, CDATA, or instruction.');
      offset = end + marker.length; continue;
    }
    if (text.startsWith('<!', offset)) throw new Error('XML DOCTYPE, ENTITY declarations, and DTD processing are prohibited.');
    let end = offset + 1, quote;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) { if (char === quote) quote = undefined; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === text.length) throw new Error('Malformed XML: unterminated tag.');
    const tag = text.slice(offset + 1, end);
    if (tag.startsWith('/')) depth--;
    else {
      if (++nodes > MAX_NODES) throw new Error('XML exceeds the 100000-node parsing limit.');
      if (++depth > MAX_DEPTH) throw new Error('XML exceeds the 128-level nesting limit.');
      if (/\/\s*$/.test(tag)) depth--;
    }
    offset = end + 1;
  }
  return nodes;
}

function xmlEntities(value) {
  return String(value).replace(/&([^;&\s<]*);/g, (raw, name) => {
    const predefined = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
    if (Object.hasOwn(predefined, name)) return predefined[name];
    const numeric = /^#(?:x[0-9a-f]+|[0-9]+)$/i.test(name);
    if (!numeric || name.length > 64) throw new Error(`XML custom entity references are prohibited: ${raw.slice(0, 80)}`);
    const code = Number.parseInt(name[1].toLowerCase() === 'x' ? name.slice(2) : name.slice(1), name[1].toLowerCase() === 'x' ? 16 : 10);
    if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code < 0x20 && ![9, 10, 13].includes(code)) || [0xfffe, 0xffff].includes(code)) throw new Error('XML contains an invalid character reference.');
    return String.fromCodePoint(code);
  });
}

function extractXml(text, decoded) {
  const nodes = checkXml(text);
  const valid = XMLValidator.validate(text, { allowBooleanAttributes: false });
  if (valid !== true) throw new Error(`Malformed XML at line ${valid.err.line}: ${valid.err.msg}`);
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, parseAttributeValue: false, processEntities: false, htmlEntities: false, trimValues: false, ignoreDeclaration: true, ignorePiTags: true, cdataPropName: '#cdata', maxNestedTags: MAX_DEPTH });
  const tree = parser.parse(text);
  const output = boundedOutput('xml', [...decoded.warnings], { encoding: decoded.encoding, encoding_source: decoded.encoding_source, parsed_nodes: nodes });
  function visit(children, parentPath = '') {
    const counters = new Map();
    for (const entry of children) {
      for (const [name, value] of Object.entries(entry)) {
        if (name === ':@') continue;
        const number = (counters.get(name) ?? 0) + 1; counters.set(name, number);
        if (name === '#text' || name === '#cdata') {
          const raw = name === '#cdata' ? (Array.isArray(value) ? value.map(item => item['#text'] ?? '').join('') : String(value)) : xmlEntities(value);
          output.add({ kind: 'xml_node', path: `${parentPath}/${name === '#text' ? 'text()' : 'cdata()'}[${number}]` }, raw);
          continue;
        }
        if (name.startsWith('?') || name.startsWith('#')) continue;
        const nodePath = `${parentPath}/${name}[${number}]`;
        for (const [attribute, raw] of Object.entries(entry[':@'] ?? {})) {
          if (attribute === 'xmlns' || attribute.startsWith('xmlns:')) continue;
          output.add({ kind: 'xml_node', path: `${nodePath}/@${attribute}` }, `${attribute}=${xmlEntities(raw)}`);
        }
        if (Array.isArray(value)) visit(value, nodePath);
      }
    }
  }
  visit(tree);
  return output.result();
}

/** Extract local HTML/XML bytes without executing scripts, loading URLs, or resolving entities. */
export function extractMarkup(bytes, { kind, encoding } = {}) {
  if (kind !== 'html' && kind !== 'xml') throw new Error('Markup kind must be html or xml.');
  const decoded = decodeText(bytes, { encoding });
  return kind === 'html' ? extractHtml(decoded.text, decoded) : extractXml(decoded.text, decoded);
}
