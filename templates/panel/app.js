// Knowledge panel UI. Zero dependencies, no build step, no innerHTML: every value from the vault is
// inserted as text, so note and source content can never become markup.

const VIEWS = ['overview', 'notes', 'sources', 'audit', 'maintenance', 'rules'];

const state = {
  describe: null,
  lock: null,
  notes: { query: '', include_archived: false, total: 0, mode: 'catalog' },
  sources: { offset: 0, limit: 50 },
  selected: null,
};

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw Object.assign(new Error(`HTTP ${response.status}：响应不是 JSON。`), { code: `HTTP_${response.status}` }); }
  if (!response.ok || payload?.ok === false) {
    throw Object.assign(new Error(payload?.error?.message ?? `HTTP ${response.status}`), { code: payload?.error?.code ?? `HTTP_${response.status}` });
  }
  return payload.data;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'value') node.value = String(value);
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key === 'disabled') node.disabled = Boolean(value);
    else if (typeof value === 'function' && key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children ?? [])) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

const text = value => document.createTextNode(value === null || value === undefined ? '—' : String(value));

function cell(value) {
  if (value instanceof Node) return value;
  return text(value === null || value === undefined || value === '' ? '—' : value);
}

function table(headers, rows) {
  return el('table', { class: 'grid' }, [
    el('thead', {}, [el('tr', {}, headers.map(header => el('th', { text: header })))]),
    el('tbody', {}, rows.map(row => el('tr', {}, row.map(cell)))),
  ]);
}

function kv(pairs) {
  return el('dl', { class: 'kv' }, pairs.map(([key, value]) => el('div', { class: 'kv-row' }, [
    el('dt', { text: key }),
    el('dd', {}, [cell(value)]),
  ])));
}

function card(title, subtitle, children) {
  return el('section', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { text: title }),
      subtitle ? el('p', { class: 'muted small', text: subtitle }) : null,
    ]),
    ...[].concat(children ?? []),
  ]);
}

const code = value => el('pre', { class: 'code' }, [text(value ?? '')]);
const hint = value => el('p', { class: 'note', text: value });
const badge = (value, kind) => el('span', { class: `badge${kind ? ` ${kind}` : ''}`, text: value });

function errorBox(error) {
  const children = [el('strong', { text: `请求失败：${error.code ?? 'ERROR'}` }), el('p', { text: error.message })];
  if (error.code === 'VAULT_LOCKED') children.push(el('p', { class: 'small', text: '知识服务正在写入。这份视图需要一致的目录快照，请稍后重试，或在「维护」标签查看写锁归属。' }));
  if (error.code === 'CROSS_ORIGIN') children.push(el('p', { class: 'small', text: '面板没有身份验证，只接受同源请求。' }));
  return el('div', { class: 'alert' }, children);
}

const formatBytes = value => (typeof value === 'number' ? `${value} B（${(value / 1024).toFixed(1)} KiB）` : '—');

function updateHeader() {
  const describe = state.describe;
  const lock = state.lock;
  document.getElementById('vault-line').textContent = describe
    ? `知识库：${describe.vault}　·　版本 ${describe.panel_version}`
    : '正在连接…';
  const badges = [];
  badges.push(badge('只读 + 维护', 'ok'));
  badges.push(badge('不提供笔记编辑'));
  badges.push(badge('不提供任意命令'));
  if (lock) badges.push(lock.locked ? badge(`写锁被 ${lock.owner?.pid ?? '?'} 持有`, 'warn') : badge('写锁空闲', 'ok'));
  document.getElementById('badges').replaceChildren(...badges);
}

let current = null;

function show(view) {
  current = view;
  for (const name of VIEWS) document.getElementById(`view-${name}`).hidden = name !== view;
  for (const button of document.querySelectorAll('.tab')) button.classList.toggle('active', button.dataset.view === view);
  // The fragment names the current tab so a view can be linked to directly.
  history.replaceState(null, '', `#${view}`);
  const render = { overview: renderOverview, notes: renderNotes, sources: renderSources, audit: renderAudit, maintenance: renderMaintenance, rules: renderRules }[view];
  render().catch(error => { document.getElementById(`view-${view}`).replaceChildren(errorBox(error)); });
}

// ---------------------------------------------------------------- overview

async function renderOverview() {
  const section = document.getElementById('view-overview');
  section.replaceChildren(hint('正在读取概览…'));
  const [describe, lock] = await Promise.all([api('/api/describe'), api('/api/lock')]);
  state.describe = describe;
  state.lock = lock;
  updateHeader();
  const nodes = [
    card('服务与库', '面板只读取知识库；唯一的写入操作在「维护」标签，且需要显式确认。', kv([
      ['知识库路径', describe.vault],
      ['面板版本', describe.panel_version],
      ['笔记编辑', describe.note_editing ? '允许' : '不提供'],
      ['资料导入', describe.source_importing ? '允许' : '不提供'],
      ['任意命令', describe.arbitrary_commands ? '允许' : '不提供'],
      ['需要加锁的读取', describe.locked_reads.join('、')],
      ['维护操作', describe.maintenance_actions.join('、')],
      ['原件大小上限', `${describe.limits.max_source_mib} MiB`],
    ])),
    card('写锁', '写入方持有跨进程写锁时，需要一致快照的读取会返回 409；锁空闲不代表没有其他读取方。', kv([
      ['状态', lock.locked ? '被占用' : '空闲'],
      ['进程', lock.owner?.pid ?? '—'],
      ['主机', lock.owner?.hostname ?? '—'],
      ['开始时间', lock.owner?.started_at ?? '—'],
    ])),
  ];
  let status = null;
  try { status = await api('/api/status'); }
  catch (error) { nodes.push(errorBox(error)); }
  if (status) {
    nodes.push(card('笔记与资料', null, kv([
      ['笔记总数', `${status.notes.total}（活跃 ${status.notes.active}／归档 ${status.notes.archived}）`],
      ['分类', `概念 ${status.notes.concepts}／实体 ${status.notes.entities}／综合 ${status.notes.syntheses}`],
      ['raw 原件', `${status.sources.totalRaw}（被引用 ${status.sources.referencedRaw}／未引用 ${status.sources.pendingCount}）`],
      ['计数口径', status.source_accounting],
    ])));
    const pending = status.sources.pending ?? [];
    if (pending.length) {
      nodes.push(card('未被任何笔记引用的原件', '未引用只说明没有笔记引用它，不代表资料无效、重复或已整理。', [
        el('ul', { class: 'list' }, pending.slice(0, 50).map(path => el('li', { text: path }))),
        pending.length > 50 ? hint(`仅显示前 50 项，共 ${pending.length} 项。`) : null,
      ]));
    }
  }
  section.replaceChildren(...nodes);
}

// ---------------------------------------------------------------- notes

async function renderNotes() {
  const section = document.getElementById('view-notes');
  section.replaceChildren(hint('正在读取笔记…'));
  const input = el('input', { type: 'search', placeholder: '标题、别名、标签、摘要或正文', value: state.notes.query });
  const archived = el('input', { type: 'checkbox', checked: state.notes.include_archived });
  const form = el('form', { class: 'toolbar', onsubmit: event => {
    event.preventDefault();
    state.notes.query = input.value.trim();
    state.notes.include_archived = archived.checked;
    fillNotes(listBox);
  } }, [
    input,
    el('button', { type: 'submit', text: '检索' }),
    el('button', { type: 'button', class: 'ghost', text: '清除', onclick: () => { input.value = ''; state.notes.query = ''; fillNotes(listBox); } }),
    el('label', {}, [archived, text('包含归档笔记')]),
  ]);
  const listBox = el('div');
  const detailBox = el('div', { id: 'note-detail' });
  section.replaceChildren(el('section', { class: 'card' }, [form, hint('列表读取不写文件、不取写锁；打开单篇笔记与历史会短暂取写锁。')]), detailBox, listBox);
  await fillNotes(listBox);
}

async function fillNotes(box) {
  box.replaceChildren(hint('正在读取…'));
  try {
    const params = new URLSearchParams({ limit: '200', include_archived: String(state.notes.include_archived) });
    if (state.notes.query) params.set('query', state.notes.query);
    const data = await api(`/api/notes?${params.toString()}`);
    state.notes.total = data.total;
    state.notes.mode = data.mode;
    if (!data.entries.length) {
      box.replaceChildren(card('笔记（0）', data.mode === 'search' ? `检索词：${data.query}` : null, [hint('没有匹配的笔记。')]));
      return;
    }
    const rows = data.entries.map(entry => [
      el('button', { type: 'button', class: 'link', text: entry.title, onclick: () => selectNote(entry.relativePath, box) }),
      entry.type,
      entry.tags.join('、'),
      entry.review_status,
      entry.last_updated ?? '—',
      entry.revision.slice(0, 8),
      entry.archived ? '已归档' : '活跃',
    ]);
    box.replaceChildren(card(
      `笔记（${data.mode === 'search' ? '检索' : '目录'}：共 ${data.total} 条）`,
      data.mode === 'search' ? `检索词：${data.query}　·　最多返回 200 条` : '目录模式按路径排序，最多显示 200 条；默认隐藏归档笔记。',
      [table(['标题', '类型', '标签', '复核', '更新', 'revision', '状态'], rows)],
    ));
  } catch (error) { box.replaceChildren(errorBox(error)); }
}

async function selectNote(identifier) {
  const target = document.getElementById('note-detail');
  target.replaceChildren(hint(`正在读取 ${identifier}…`));
  try {
    const note = await api(`/api/note?pathOrTitle=${encodeURIComponent(identifier)}`);
    state.selected = note.relativePath;
    target.replaceChildren(noteDetail(note));
    target.scrollIntoView({ block: 'start' });
  } catch (error) { target.replaceChildren(errorBox(error)); }
}

function noteDetail(note) {
  const frontmatter = note.frontmatter ?? {};
  const historyBox = el('div');
  const links = note.links ?? [];
  const backlinks = note.backlinks ?? [];
  return card(note.title, note.relativePath, [
    kv([
      ['类型', note.type],
      ['复核状态', `${frontmatter.review_status ?? 'draft'}（调用者的声明，不是服务器的真实性证明）`],
      ['适用范围', frontmatter.scope || '—'],
      ['标签', (note.tags ?? []).join('、') || '—'],
      ['别名', (note.aliases ?? []).join('、') || '—'],
      ['来源', (note.sources ?? []).join('、') || '—'],
      ['归档', note.archived ? '是' : '否'],
      ['当前 revision', note.revision],
    ]),
    el('h3', { text: `出链（${links.length}）` }),
    links.length ? table(['原文', '目标', '锚点'], links.map(link => [link.raw, link.target, link.anchor ?? '—'])) : hint('没有出链。'),
    el('h3', { text: `反链（${backlinks.length}）` }),
    backlinks.length ? table(['来自', '路径', '链接写法'], backlinks.map(link => [link.fromTitle, link.fromFile, link.linkText])) : hint('没有反链。'),
    el('h3', { text: '正文（Markdown 原文，未渲染）' }),
    code(note.content),
    el('h3', { text: '历史版本' }),
    hint('历史从首次由本服务维护时开始保存；版本内容是当时的正文原文，只读。'),
    el('button', { type: 'button', class: 'ghost', text: '加载历史版本', onclick: () => loadHistory(historyBox, note.relativePath) }),
    historyBox,
  ]);
}

async function loadHistory(box, identifier) {
  box.replaceChildren(hint('正在读取历史…'));
  try {
    const data = await api(`/api/history?pathOrTitle=${encodeURIComponent(identifier)}`);
    const rows = data.versions.map(version => [
      version.revision.slice(0, 12),
      version.recorded_at,
      version.operation,
      el('button', { type: 'button', class: 'link', text: '查看正文', onclick: () => loadRevision(box, identifier, version.revision) }),
    ]);
    box.replaceChildren(
      el('p', { class: 'small muted', text: `路径：${data.relativePath}　·　当前 revision：${data.current_revision ?? '（文件当前缺失）'}` }),
      data.versions.length ? table(['revision', '记录时间', '操作', '正文'], rows) : hint('这个路径还没有历史版本。'),
    );
  } catch (error) { box.replaceChildren(errorBox(error)); }
}

async function loadRevision(box, identifier, revision) {
  try {
    const record = await api(`/api/history?pathOrTitle=${encodeURIComponent(identifier)}&revision=${encodeURIComponent(revision)}`);
    box.replaceChildren(
      el('p', { class: 'small muted', text: `${record.operation}　·　${record.recorded_at}　·　${record.revision}` }),
      code(record.rawMarkdown),
      el('button', { type: 'button', class: 'ghost', text: '返回版本列表', onclick: () => loadHistory(box, identifier) }),
    );
  } catch (error) { box.replaceChildren(errorBox(error)); }
}

// ---------------------------------------------------------------- sources

async function renderSources() {
  const section = document.getElementById('view-sources');
  section.replaceChildren(hint('正在读取原始资料…'));
  const listBox = el('div');
  const checkBox = el('div');
  const toolbar = el('div', { class: 'toolbar' }, [
    el('button', { type: 'button', class: 'ghost', text: '检查资料一致性', onclick: async () => {
      checkBox.replaceChildren(hint('正在检查…'));
      try { checkBox.replaceChildren(checkReport(await api('/api/sources/check'))); }
      catch (error) { checkBox.replaceChildren(errorBox(error)); }
    } }),
    el('button', { type: 'button', class: 'ghost', text: '刷新列表', onclick: () => fillSources(listBox) }),
  ]);
  section.replaceChildren(card('原始资料', 'raw/ 下的原件不可改写：登记只记录哈希，导入同内容会去重，内容不同的同名文件另存新路径。', [toolbar]), checkBox, listBox);
  await fillSources(listBox);
}

async function fillSources(box) {
  box.replaceChildren(hint('正在读取…'));
  try {
    const data = await api(`/api/sources?offset=${state.sources.offset}&limit=${state.sources.limit}`);
    const rows = data.entries.map(entry => [
      entry.path,
      entry.registered ? '已登记' : '未登记',
      entry.registered ? entry.integrity : '—',
      formatBytes(entry.bytes),
      entry.type ?? '—',
      entry.created_at ?? '—',
    ]);
    const pager = el('div', { class: 'toolbar' }, [
      el('button', { type: 'button', class: 'ghost', text: '上一页', disabled: state.sources.offset <= 0, onclick: () => { state.sources.offset = Math.max(0, state.sources.offset - state.sources.limit); fillSources(box); } }),
      el('button', { type: 'button', class: 'ghost', text: '下一页', disabled: data.next_offset === null, onclick: () => { state.sources.offset = data.next_offset; fillSources(box); } }),
      el('span', { class: 'small muted', text: `第 ${data.offset + 1}–${data.offset + data.entries.length} 项，共 ${data.total} 项` }),
    ]);
    const nodes = [
      pager,
      data.entries.length ? table(['路径', '登记', '完整性', '大小', '类型', '登记时间'], rows) : hint('raw/ 下还没有资料。'),
      hint(data.compilation_status),
    ];
    if (data.scan_issues?.length) nodes.push(el('h3', { text: '扫描问题' }), table(['路径', '说明'], data.scan_issues.map(issue => [issue.path, issue.error])));
    box.replaceChildren(...nodes);
  } catch (error) { box.replaceChildren(errorBox(error)); }
}

function checkReport(data) {
  const problems = data.sources.filter(source => source.integrity !== 'ok');
  const nodes = [
    el('div', { class: 'toolbar' }, [
      data.has_source_problems ? badge('发现问题', 'danger') : badge('未发现问题', 'ok'),
      el('span', { class: 'small muted', text: `检查时间：${data.checked_at}` }),
    ]),
    kv([
      ['登记来源', data.sources.length],
      ['未登记原件', data.unregistered_sources.length],
      ['受影响笔记', data.affected_notes.length],
      ['引用条目', data.references.length],
      ['扫描问题', data.scan_issues.length],
      ['口径', data.compilation_status],
    ]),
  ];
  if (problems.length) {
    nodes.push(el('h3', { text: '原件状态异常' }), table(['路径', '完整性', '登记哈希', '当前哈希'],
      problems.map(source => [source.path, source.integrity, source.registered_sha256?.slice(0, 12) ?? '—', source.sha256?.slice(0, 12) ?? '—'])));
  }
  if (data.affected_notes.length) {
    nodes.push(el('h3', { text: '受影响的笔记' }), table(['路径', '标题', '归档', '问题'],
      data.affected_notes.map(note => [note.path, note.title, note.archived ? '是' : '否',
        note.issues.map(issue => `${issue.reference}：${issue.issue}${issue.newer_versions ? `（新版本 ${issue.newer_versions.map(id => id.slice(7, 15)).join('、')}）` : ''}`).join('；')])));
  }
  if (data.unregistered_sources.length) {
    nodes.push(el('h3', { text: '未登记原件' }), el('ul', { class: 'list' }, data.unregistered_sources.map(path => el('li', { text: path }))));
  }
  if (data.scan_issues.length) {
    nodes.push(el('h3', { text: '扫描问题' }), table(['路径', '说明'], data.scan_issues.map(issue => [issue.path, issue.error])));
  }
  return card('资料一致性检查', '引用只表示被 cite，不表示资料已被完整整理或独立验证。', nodes);
}

// ---------------------------------------------------------------- audit

async function renderAudit() {
  const section = document.getElementById('view-audit');
  section.replaceChildren(hint('正在运行审计…'));
  const [lint, check] = await Promise.allSettled([api('/api/lint'), api('/api/sources/check')]);
  const nodes = [
    el('div', { class: 'toolbar' }, [el('button', { type: 'button', class: 'ghost', text: '重新运行审计', onclick: () => show('audit') })]),
  ];
  nodes.push(lint.status === 'fulfilled' ? lintReport(lint.value) : errorBox(lint.reason));
  nodes.push(check.status === 'fulfilled' ? checkReport(check.value) : errorBox(check.reason));
  section.replaceChildren(...nodes);
}

function lintReport(data) {
  const nodes = [
    el('div', { class: 'toolbar' }, [data.healthy ? badge('结构健康', 'ok') : badge(`${data.issues.length} 个问题`, 'warn'), el('span', { class: 'small muted', text: data.message })]),
  ];
  if (data.issues.length) {
    nodes.push(table(['类型', '路径', '目标', '说明'], data.issues.map(issue => [issue.type, issue.path ?? '—', issue.target ?? '—', issue.message ?? '—'])));
  } else {
    nodes.push(hint('没有重名、断链或孤立笔记。这不检查技术结论是否正确。'));
  }
  return card('笔记结构审计', '检查重名标识、断开的 wikilink 和孤立笔记；不评价内容正确性。', nodes);
}

// ---------------------------------------------------------------- maintenance

async function renderMaintenance() {
  const section = document.getElementById('view-maintenance');
  section.replaceChildren(hint('正在读取维护状态…'));
  const [describe, lock] = await Promise.all([api('/api/describe'), api('/api/lock')]);
  state.describe = describe;
  state.lock = lock;
  updateHeader();
  const resultBox = el('div');
  const logBox = el('div');
  const nodes = [
    card('维护操作', '面板只有这两个写入操作，都复用知识服务已有的 vault 锁与事务日志；不编辑笔记正文，也不导入资料。', [
      el('div', { class: 'toolbar' }, [
        el('button', { type: 'button', text: '重建索引', onclick: () => runMaintenance('/api/maintenance/rebuild-index', '重建索引会重写 wiki/index.md 的生成区域并追加一行 wiki/log.md，不会改动任何笔记正文。确定继续？', resultBox) }),
        el('button', { type: 'button', class: 'danger', text: '恢复写锁', disabled: !lock.locked, onclick: () => runMaintenance('/api/maintenance/recover-lock', '只有在锁来自本机、且持有进程已不存在时才会移除锁；活进程、不同主机或无法判断时会拒绝。确定继续？', resultBox) }),
      ]),
      resultBox,
    ]),
    card('写锁详情', '进程崩溃不会按时间自动解锁；锁文件位于 .wiki-server/write.lock/。', kv([
      ['状态', lock.locked ? '被占用' : '空闲'],
      ['进程', lock.owner?.pid ?? '—'],
      ['主机', lock.owner?.hostname ?? '—'],
      ['开始时间', lock.owner?.started_at ?? '—'],
      ['token', lock.owner?.token ? `${lock.owner.token.slice(0, 8)}…` : '—'],
    ])),
    card('审计日志尾部', 'wiki/log.md 由服务和面板追加，不在面板里编辑。', [
      el('div', { class: 'toolbar' }, [
        el('button', { type: 'button', class: 'ghost', text: '重新读取', onclick: () => fillLog(logBox) }),
        el('button', { type: 'button', class: 'ghost', text: '载入 1000 行', onclick: () => fillLog(logBox, 1000) }),
      ]),
      logBox,
    ]),
  ];
  section.replaceChildren(...nodes);
  await fillLog(logBox);
}

async function runMaintenance(path, prompt, box) {
  if (!window.confirm(prompt)) return;
  box.replaceChildren(hint('正在执行…'));
  try {
    const data = await api(path, { method: 'POST', body: { confirm: true } });
    box.replaceChildren(
      el('div', { class: 'toolbar' }, [badge('已完成', 'ok'), el('span', { class: 'small muted', text: data.action })]),
      code(JSON.stringify(data, null, 2)),
      hint('结果只说明这次维护操作发生了什么，不代表知识已被验证。'),
    );
    if (data.action === 'recover_lock') updateHeader();
  } catch (error) { box.replaceChildren(errorBox(error)); }
}

async function fillLog(box, lines = 200) {
  box.replaceChildren(hint('正在读取日志…'));
  try {
    const data = await api(`/api/log?lines=${lines}`);
    if (!data.available) { box.replaceChildren(hint('wiki/log.md 不存在；该库可能尚未初始化。')); return; }
    box.replaceChildren(
      el('p', { class: 'small muted', text: `共 ${data.total_lines} 行，显示最后 ${data.returned} 行。` }),
      code(data.lines.join('\n')),
    );
  } catch (error) { box.replaceChildren(errorBox(error)); }
}

// ---------------------------------------------------------------- rules & index

async function renderRules() {
  const section = document.getElementById('view-rules');
  section.replaceChildren(hint('正在读取目录与规范…'));
  const indexBox = el('div');
  const archived = el('input', { type: 'checkbox' });
  const nodes = [
    el('div', { class: 'toolbar' }, [
      el('label', {}, [archived, text('目录包含归档笔记')]),
      el('button', { type: 'button', class: 'ghost', text: '重新生成目录预览', onclick: () => fillIndex(indexBox, archived.checked) }),
      el('span', { class: 'small muted', text: '预览只在内存中渲染，不写入 wiki/index.md；写入需要到「维护」标签重建索引。' }),
    ]),
    indexBox,
  ];
  section.replaceChildren(...nodes);
  await fillIndex(indexBox, false);
  try {
    const rules = await api('/api/rules');
    section.append(card('库内整理规范（AGENTS.md）', '面板只读取，不修改规范文件。', [code(rules.markdown)]));
  } catch (error) { section.append(errorBox(error)); }
}

async function fillIndex(box, includeArchived) {
  box.replaceChildren(hint('正在渲染目录…'));
  try {
    const data = await api(`/api/index?include_archived=${includeArchived ? 'true' : 'false'}`);
    box.replaceChildren(card('目录预览', `include_archived: ${data.include_archived}`, [code(data.markdown)]));
  } catch (error) { box.replaceChildren(errorBox(error)); }
}

// ---------------------------------------------------------------- bootstrap

for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => show(button.dataset.view));
}
// Switching only the fragment does not reload the page, so follow hash edits and back/forward.
window.addEventListener('hashchange', () => {
  const next = window.location.hash.replace(/^#/, '');
  if (VIEWS.includes(next) && next !== current) show(next);
});
const requested = window.location.hash.replace(/^#/, '');
show(VIEWS.includes(requested) ? requested : 'overview');
