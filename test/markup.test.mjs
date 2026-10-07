import test from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { decodeText } from '../src/lib/extractors/text.mjs';
import { extractMarkup } from '../src/lib/extractors/markup.mjs';

const bytes = text => Buffer.from(text, 'utf8');
const content = result => result.units.map(unit => unit.text).join('\n');

test('text decoding supports BOM and explicit or declared Chinese encodings without guessing', () => {
  assert.equal(decodeText(bytes('中文')).encoding_source, 'strict_utf8');
  for (const encoding of ['utf-8', 'utf-16le', 'utf-16be']) {
    const bom = encoding === 'utf-8' ? Buffer.from([0xef, 0xbb, 0xbf]) : encoding === 'utf-16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]);
    const result = decodeText(Buffer.concat([bom, iconv.encode('中文\n第二行', encoding)]));
    assert.equal(result.text, '中文\n第二行');
    assert.equal(result.encoding, encoding);
    assert.equal(result.encoding_source, 'bom');
  }
  for (const encoding of ['gbk', 'gb18030']) {
    const source = iconv.encode('中文原始资料', encoding);
    assert.throws(() => decodeText(source), /not valid utf-8.*encoding explicitly/i);
    assert.equal(decodeText(source, { encoding }).text, '中文原始资料');
    assert.equal(decodeText(source, { encoding }).encoding_source, 'explicit');
  }
  const html = iconv.encode('<meta charset="GBK"><p>中文内容</p>', 'gbk');
  assert.equal(decodeText(html).encoding_source, 'declaration');
  assert.match(decodeText(html).text, /中文内容/);
  const xml = iconv.encode('<?xml version="1.0" encoding="gb18030"?><文档>中文内容</文档>', 'gb18030');
  assert.equal(decodeText(xml).encoding, 'gb18030');
  assert.match(content(extractMarkup(xml, { kind: 'xml' })), /中文内容/);
});

test('text decoding rejects binary, malformed Unicode, unsupported or conflicting encoding', () => {
  assert.throws(() => decodeText(bytes('a\0b')), /NUL/);
  assert.throws(() => decodeText(Buffer.from([0xff, 0xfe, 0x61])), /not valid utf-16le/);
  assert.throws(() => decodeText(bytes('hello'), { encoding: 'madeup-xyz' }), /Unsupported text encoding/);
  assert.throws(() => decodeText(Buffer.from([0xff, 0xfe, 0x61, 0]), { encoding: 'utf-8' }), /conflicts/);
  assert.throws(() => decodeText(bytes('hello'), { encoding: 'utf-16' }), /needs a byte-order/);
  assert.throws(() => decodeText(Buffer.from([0xff, 0xfe, 0, 0])), /UTF-32/);
  const result = decodeText(bytes('<meta charset="windows-1252"><p>文本</p>'), { encoding: 'utf8' });
  assert.match(result.warnings.join(' '), /overrides/);
});

test('HTML extraction removes executable/navigation noise and preserves cited semantic text', () => {
  globalThis.__markupExecuted = false;
  const input = `<!DOCTYPE html><html><head><title>测试标题</title><script>globalThis.__markupExecuted = true; fetch('http://example.invalid');</script><style>secret style</style></head>
<body><nav>导航噪声</nav><header>页眉噪声</header><main><h1>主标题</h1><p>Hello <strong>world</strong> &amp; 中文<br>second line</p><ul><li>first</li><li>second<ul><li>nested</li></ul></li></ul><table><tr><th>名称</th><th>数值</th></tr><tr><td>温度</td><td>24</td></tr></table><pre> x = 1;\n y = 2;</pre><p hidden>隐藏噪声</p><p aria-hidden="true">ARIA噪声</p><div role="navigation">role噪声</div><p style="display:none">CSS噪声</p><img src="http://example.invalid/image.png" alt="结构图说明"></main><footer>页脚噪声</footer></body></html>`;
  const result = extractMarkup(bytes(input), { kind: 'html' });
  assert.equal(globalThis.__markupExecuted, false);
  delete globalThis.__markupExecuted;
  assert.match(content(result), /测试标题/);
  assert.match(content(result), /主标题/);
  assert.match(content(result), /Hello world & 中文\nsecond line/);
  assert.match(content(result), /- first/);
  assert.match(content(result), /- nested/);
  assert.match(content(result), /名称 \| 数值\n温度 \| 24/);
  assert.match(content(result), /x = 1;\n y = 2;/);
  assert.match(content(result), /结构图说明/);
  assert.doesNotMatch(content(result), /噪声|secret style|__markupExecuted|fetch\(/);
  const heading = result.units.find(unit => unit.text === '主标题');
  assert.deepEqual(heading.locator, { kind: 'html_node', path: '/html[1]/body[1]/main[1]/h1[1]', line: 2 });
  assert.equal(result.metadata.truncated, false);
});

test('HTML supports declared meta charset and http-equiv encoding', () => {
  for (const meta of ['<meta charset=GBK>', '<meta http-equiv="content-type" content="text/html; charset=GB18030">']) {
    const result = extractMarkup(iconv.encode(`${meta}<p>中文标题</p>`, 'gb18030'), { kind: 'html' });
    assert.match(content(result), /中文标题/);
    assert.equal(result.metadata.encoding_source, 'declaration');
  }
});

test('XML preserves order, attributes, namespace paths, predefined references and literal CDATA', () => {
  const input = '<?xml version="1.0"?><root xmlns:x="urn:local"><x:item id="a&amp;b">first &lt; &#x4e2d;<b>nested</b> last</x:item><x:item id="2"><![CDATA[A &thing; <b>literal</b>]]></x:item></root>';
  const result = extractMarkup(bytes(input), { kind: 'xml' });
  assert.deepEqual(result.units.map(unit => [unit.locator.path, unit.text]), [
    ['/root[1]/x:item[1]/@id', 'id=a&b'],
    ['/root[1]/x:item[1]/text()[1]', 'first < 中'],
    ['/root[1]/x:item[1]/b[1]/text()[1]', 'nested'],
    ['/root[1]/x:item[1]/text()[2]', 'last'],
    ['/root[1]/x:item[2]/@id', 'id=2'],
    ['/root[1]/x:item[2]/cdata()[1]', 'A &thing; <b>literal</b>'],
  ]);
  assert.ok(result.units.every(unit => unit.locator.kind === 'xml_node'));
});

test('XML refuses external/internal DTDs, custom entities, malformed XML and unsafe depth', () => {
  for (const source of [
    '<!DOCTYPE root SYSTEM "file:///etc/passwd"><root/>',
    '<!DOCTYPE root [<!ENTITY a "boom">]><root>&a;</root>',
    '<!ENTITY a SYSTEM "http://example.invalid"><root/>',
  ]) assert.throws(() => extractMarkup(bytes(source), { kind: 'xml' }), /DOCTYPE|ENTITY|DTD/);
  assert.throws(() => extractMarkup(bytes('<root>&custom;</root>'), { kind: 'xml' }), /custom entity/);
  assert.throws(() => extractMarkup(bytes('<root>&#0;</root>'), { kind: 'xml' }), /invalid character/);
  assert.throws(() => extractMarkup(bytes('<root><broken></root>'), { kind: 'xml' }), /Malformed XML/);
  assert.throws(() => extractMarkup(bytes('<a>'.repeat(129) + '</a>'.repeat(129)), { kind: 'xml' }), /128-level/);
  assert.throws(() => extractMarkup(bytes('<root>' + '<i/>'.repeat(100000) + '</root>'), { kind: 'xml' }), /100000-node/);
  assert.equal(content(extractMarkup(bytes('<root><!-- <!DOCTYPE is literal here> --><![CDATA[<!ENTITY is literal>]]></root>'), { kind: 'xml' })), '<!ENTITY is literal>');
});

test('markup limits output per unit, total bytes, count and tree depth without hiding truncation', () => {
  const unit = extractMarkup(bytes('<p>' + '中'.repeat(100001) + '</p>'), { kind: 'html' });
  assert.equal(unit.units[0].text.length, 100000);
  assert.equal(unit.metadata.truncated, true);
  assert.match(unit.warnings.join(' '), /truncated/);
  // A cut unit must be identifiable on its own: the global flag alone cannot say which evidence was shortened.
  assert.equal(unit.units[0].locator.truncated, true);
  assert.match(unit.units[0].locator.truncation_reason, /100000 characters/);
  const total = extractMarkup(bytes('<body>' + ('<p>' + '中'.repeat(100000) + '</p>').repeat(15) + '</body>'), { kind: 'html' });
  assert.ok(total.metadata.output_bytes <= 4 * 1024 * 1024);
  assert.equal(total.metadata.truncated, true);
  assert.ok(total.units.some(item => item.locator.truncated === true));
  assert.match(total.warnings.join(' '), /total output limit/);
  const count = extractMarkup(bytes('<root>' + '<i>v</i>'.repeat(10001) + '</root>'), { kind: 'xml' });
  assert.equal(count.units.length, 10000);
  assert.equal(count.metadata.truncated, true);
  assert.match(count.warnings.join(' '), /10000-unit limit/);
  assert.throws(() => extractMarkup(bytes('<div>'.repeat(129) + 'x' + '</div>'.repeat(129)), { kind: 'html' }), /128-level/);
});
