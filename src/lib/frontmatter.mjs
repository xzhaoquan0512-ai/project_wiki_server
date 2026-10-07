import { parseDocument, stringify } from 'yaml';

const rejectExecutable = () => { throw new Error('Executable frontmatter is not supported. Use YAML or JSON data.'); };

function validate(input) {
  const text = typeof input === 'string' ? input : input?.content;
  if (typeof text !== 'string') throw new Error('Markdown must be a string.');
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('Markdown exceeds the 2 MiB parsing limit.');
  return text.replace(/^\uFEFF/, '');
}

function parse(input) {
  const text = validate(input);
  const header = /^---([^\r\n]*)\r?\n/.exec(text);
  if (!header) return { data: {}, content: text };
  const language = header[1].trim().toLowerCase();
  if (language && !['yaml', 'yml', 'json'].includes(language)) rejectExecutable();
  const tail = text.slice(header[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(tail);
  if (!closing) throw new Error('Frontmatter is missing its closing delimiter.');
  const block = tail.slice(0, closing.index);
  if (Buffer.byteLength(block, 'utf8') > 128 * 1024) throw new Error('Frontmatter exceeds 128 KiB.');
  let data;
  if (language === 'json') data = block.trim() ? JSON.parse(block) : {};
  else {
    const document = parseDocument(block, { schema: 'core', stringKeys: true, uniqueKeys: true, customTags: [], logLevel: 'error' });
    if (document.errors.length || document.warnings.length) throw new Error(`Invalid YAML frontmatter: ${(document.errors[0] || document.warnings[0]).message}`);
    data = document.toJS({ maxAliasCount: 50 }) ?? {};
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('Frontmatter must be a mapping.');
  // Reject circular alias graphs and non-JSON scalar values before they enter journals.
  try { JSON.stringify(data, (_key, value) => { if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite'); return value; }); }
  catch { throw new Error('Frontmatter must contain finite, acyclic JSON-compatible data.'); }
  return { data, content: tail.slice(closing.index + closing[0].length) };
}
parse.stringify = (input, data) => {
  const parsed = parse(input);
  const output = `---\n${stringify(data ?? parsed.data, { schema: 'core', lineWidth: 0, aliasDuplicateObjects: false })}---\n${parsed.content}`;
  parse(output);
  return output;
};
export default parse;
