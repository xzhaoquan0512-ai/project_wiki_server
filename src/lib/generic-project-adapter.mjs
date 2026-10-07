import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, opendir, readFile, writeFile, rename, rmdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relativePath, containedPath, inside } from './project-paths.mjs';
import { gitHistoryCommand } from './git-history.mjs';

const execute = promisify(execFile);
const DEFAULT_STATE = fileURLToPath(new URL('../../data/project-sessions/', import.meta.url));
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const MAX_FILE = 1024 * 1024;
const MAX_SCAN = 8 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_RESULTS = 500;
const MAX_CACHE = 4 * 1024 * 1024;
const excludedDirectories = new Set(['.git', 'node_modules', 'build', 'dist', 'data', 'target', 'vendor', 'venv', '.venv', '__pycache__', '.ssh', '.aws', '.azure', '.gnupg', '.idea', '.vscode', 'coverage']);
const textExtensions = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc', '.c', '.h', '.cc', '.hh', '.cpp', '.hpp', '.cxx', '.cs', '.py', '.pyi', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.sql', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.cmake', '.ini', '.cfg', '.conf', '.rs', '.go', '.java', '.kt', '.kts', '.swift', '.rb', '.php', '.lua', '.proto', '.csv', '.log']);
const textNames = new Set(['dockerfile', 'makefile', 'cmakelists.txt', 'license', 'readme', '.gitignore', '.gitattributes', '.editorconfig']);
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

export const genericCapabilities = Object.freeze({
  backend: 'generic', selectors: ['path', 'start_line', 'end_line', 'start_column', 'offset', 'snapshot_id', 'expected_hash'],
  operations: ['begin', 'search', 'read', 'evidence', 'status', 'adjust-budget', 'git-status', 'git-history'],
  search: 'case-insensitive literal search over permitted UTF-8 text; docs searches source and docs, wiki searches wiki/ and docs/wiki/',
  unsupported_selectors: ['id', 'section', 'pointer', 'force', 'command_index', 'stream', 'include_stale', 'include_views'],
  session_storage: 'service data/project-sessions or PROJECT_WIKI_STATE; project sources stay unchanged',
  budget_unit: 'serialized response JSON UTF-16 code units; MCP framing and errors before session validation excluded',
  continuation: 'snapshot_id plus next_arguments; cached content is historical and is not revalidated',
  freshness: 'per-file SHA-256 and read time; no atomic project snapshot; evidence does not rerun verification',
  limits: { max_file_bytes: MAX_FILE, max_scan_bytes: MAX_SCAN, max_scan_files: MAX_FILES, max_search_hits: MAX_RESULTS, max_session_cache_bytes: MAX_CACHE },
  excluded_directories: [...excludedDirectories],
  excluded_files: 'binary/non-UTF-8 files, unsupported extensions, hidden files except .gitignore/.gitattributes/.editorconfig, known credentials/key filenames',
});

function permitted(relative) {
  const parts = relative.replaceAll('\\', '/').split('/');
  if (parts.slice(0, -1).some(part => part.startsWith('.') || excludedDirectories.has(part.toLowerCase()))) return false;
  const name = parts.at(-1).toLowerCase();
  if (name.startsWith('.') && !textNames.has(name)) return false;
  if (/(^|[_.-])(secrets?|credentials?|passwords?|id_rsa|id_ed25519)([_.-]|$)/i.test(name)) return false;
  return textNames.has(name) || textExtensions.has(path.extname(name));
}

function rejectSelectors(input, fields) {
  for (const field of fields) if (input[field] !== undefined) throw new Error(`The generic adapter does not support selector ${field}; see project_list capabilities.`);
}

function integer(value, fallback, min, max, name) {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return chosen;
}

function location(text, offset) {
  const before = text.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return { line: (before.match(/\n/g)?.length ?? 0) + 1, column: offset - lastNewline };
}

function lineOffset(text, line, column = 1) {
  let offset = 0;
  for (let index = 1; index < line; index++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) throw new Error('Requested line is beyond the end of the file.');
    offset = next + 1;
  }
  const end = text.indexOf('\n', offset);
  const length = (end < 0 ? text.length : end) - offset;
  if (column > length + 1) throw new Error('Requested column is beyond the end of the line.');
  return offset + column - 1;
}

async function plainFile(filename, maxBytes) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Expected a regular file, not a symbolic link.');
  if (metadata.size > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte limit.`);
  const data = await readFile(filename);
  if (data.byteLength > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte limit.`);
  return data;
}

async function readProjectFile(project, relative) {
  const normalized = relativePath(relative);
  if (!permitted(normalized)) throw new Error('File is excluded by the generic text/credential/directory policy.');
  const target = await containedPath(project.root, normalized);
  const canonical = await realpath(target);
  if (!permitted(path.relative(project.root, canonical))) throw new Error('Resolved file is excluded by the generic text/credential/directory policy.');
  const handle = await open(canonical, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE) throw new Error(`Only regular text files up to ${MAX_FILE} bytes are supported.`);
    const buffer = Buffer.alloc(before.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const part = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!part.bytesRead) break;
      bytes += part.bytesRead;
    }
    const after = await handle.stat();
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || await realpath(target) !== canonical) {
      throw new Error('File changed while being read; retry a fresh read.');
    }
    const content = buffer.subarray(0, bytes);
    if (content.includes(0)) throw new Error('Binary files are not supported.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch { throw new Error('Only valid UTF-8 text files are supported.'); }
    return { text, source: { path: normalized, sha256: hash(content), read_at: now(), size_bytes: bytes, modified_at: after.mtime.toISOString() } };
  } finally { await handle.close(); }
}

async function listFiles(project, prefixes, signal) {
  const files = [];
  let visited = 0, truncated = false;
  const walk = async relative => {
    if (signal?.aborted) throw new Error('Request cancelled.');
    const absolute = relative ? await containedPath(project.root, relative) : project.root;
    const entries = [];
    let directoryLimited = false;
    // Bound the listing too: one directory may contain millions of entries.
    for await (const entry of await opendir(absolute)) {
      if (entries.length + visited >= 20000) { directoryLimited = true; break; }
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (++visited > 20000 || files.length >= MAX_FILES) { truncated = true; return; }
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || excludedDirectories.has(entry.name.toLowerCase())) continue;
        if (!prefixes.some(prefix => !prefix || prefix.startsWith(`${child}/`) || child === prefix || child.startsWith(`${prefix}/`))) continue;
        await walk(child);
      } else if (entry.isFile() && permitted(child) && prefixes.some(prefix => !prefix || child === prefix || child.startsWith(`${prefix}/`))) files.push(child);
      if (truncated) return;
    }
    if (directoryLimited) truncated = true;
  };
  await walk('');
  return { files, truncated };
}

export class GenericProjectAdapter {
  constructor(projects, { stateDirectory = process.env.PROJECT_WIKI_STATE ?? DEFAULT_STATE, runner = execute } = {}) {
    this.projects = projects;
    this.stateDirectory = path.resolve(stateDirectory);
    this.runner = runner;
  }

  async #directory(project) {
    // State is never created under a registered source tree.
    let ancestor = this.stateDirectory, canonicalAncestor;
    while (true) {
      try { canonicalAncestor = await realpath(ancestor); break; }
      catch (error) { if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error; ancestor = path.dirname(ancestor); }
    }
    const prospectiveRoot = path.resolve(canonicalAncestor, path.relative(ancestor, this.stateDirectory));
    for (const item of this.projects.values()) {
      if (inside(item.root, this.stateDirectory) || inside(item.root, prospectiveRoot)) throw new Error('PROJECT_WIKI_STATE must be outside every registered project root.');
    }
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(this.stateDirectory);
    for (const item of this.projects.values()) if (inside(item.root, stateRoot)) throw new Error('State directory resolves inside a registered project.');
    const directory = path.join(stateRoot, hash(`${project.id}\0${project.root}`).slice(0, 32));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw new Error('Project state directory may not be a symbolic link.');
    return directory;
  }

  async call(project, operation, input, signal) {
    const maxChars = integer(input.max_chars, 4000, 1000, 16000, 'max_chars');
    const directory = await this.#directory(project);
    const sessionId = operation === 'begin' ? `GEN-${randomUUID()}` : input.session_id;
    if (!ID.test(sessionId ?? '')) throw new Error('A valid session_id is required.');
    const filename = path.join(directory, `${sessionId}.json`);
    const lock = path.join(directory, `${sessionId}.lock`);
    const started = Date.now();
    while (true) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() - started > 5000) throw new Error('Session is locked by another process; retry later. A crash lock requires manual removal after confirming no writer is active.');
        await new Promise(resolve => setTimeout(resolve, 35));
      }
    }
    try {
      let state;
      if (operation === 'begin') {
        if (input.profile !== undefined && input.profile !== 'query') throw new Error('The generic adapter supports query profile only.');
        state = { version: 1, project_id: project.id, project_root: project.root, session_id: sessionId, created_at: now(), budget: integer(input.budget, 64000, 8000, 512000, 'budget'), used_chars: 0, requests: 0, snapshots: {}, receipts: [], budget_changes: [] };
      } else {
        try { state = JSON.parse((await plainFile(filename, 12 * 1024 * 1024)).toString('utf8')); }
        catch (error) { if (error.code === 'ENOENT') throw new Error('Unknown session_id for this project; call project_begin first.'); throw error; }
        if (state.version !== 1 || state.project_id !== project.id || state.project_root !== project.root || state.session_id !== sessionId) throw new Error('Session state does not match this project.');
      }
      let backend;
      if (operation !== 'adjust-budget' && operation !== 'status' && state.budget - state.used_chars < 1000) {
        backend = { status: 'blocked', reason: 'Session budget exhausted; use project_adjust_budget with a reason, retaining this session.' };
      } else {
        try { backend = await this.#operation(project, operation, input, state, signal); }
        catch (error) { backend = { status: 'failed', error: String(error.message).slice(0, 300) }; }
      }
      const response = this.#response(project, operation, state, backend, maxChars, input);
      state.requests++;
      state.used_chars = response.accounting.used_chars;
      state.updated_at = response.observed_at;
      state.receipts.push({ operation, observed_at: response.observed_at, response_chars: response.accounting.response_chars, status: response.backend.status });
      state.receipts = state.receipts.slice(-100);
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      await rename(temporary, filename);
      return response;
    } finally { await rmdir(lock); }
  }

  #snapshot(state, snapshot) {
    const id = `SNAP-${randomUUID()}`;
    state.snapshots[id] = snapshot;
    while (Object.keys(state.snapshots).length > 8 || Buffer.byteLength(JSON.stringify(state.snapshots)) > MAX_CACHE) {
      const first = Object.keys(state.snapshots)[0];
      delete state.snapshots[first];
      if (first === id) throw new Error('Snapshot exceeds the session cache limit.');
    }
    return id;
  }

  async #operation(project, operation, input, state, signal) {
    if (operation === 'begin') {
      let rulesAvailable = false;
      try { await containedPath(project.root, 'AGENTS.md'); rulesAvailable = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { status: 'passed', profile: 'query', rules_available: rulesAvailable, next_step: rulesAvailable ? 'Read AGENTS.md with project_read, following next_arguments until complete. Reuse this session for the task.' : 'No root AGENTS.md found. Reuse this session; read applicable nested AGENTS.md when inspecting a subdirectory.' };
    }
    if (operation === 'status') return {
      status: 'passed', created_at: state.created_at, previous_requests: state.requests,
      cached_snapshots: Object.keys(state.snapshots).length, recent_receipts: state.receipts.slice(-3),
      continuation: 'Reuse a prior snapshot_id and next_arguments. Old snapshots are evicted after 8 snapshots or 4 MiB; never silently resumed against changed files.',
    };
    if (operation === 'adjust-budget') {
      const budget = integer(input.budget, undefined, 8000, 512000, 'budget');
      if (typeof input.reason !== 'string' || input.reason.length < 10 || input.reason.length > 1000) throw new Error('Budget adjustment requires a reason of 10 to 1000 characters.');
      if (budget < state.used_chars + 1000) throw new Error('New budget must cover consumed characters plus at least 1000 characters.');
      const previousBudget = state.budget;
      state.budget = budget;
      state.budget_changes = [...(state.budget_changes ?? []), { at: now(), previous_budget: previousBudget, budget, reason: input.reason }].slice(-100);
      return { status: 'passed', previous_budget: previousBudget, reason: input.reason.slice(0, 200) };
    }
    if (operation === 'search') return this.#search(project, input, state, signal);
    if (operation === 'read' || operation === 'evidence') return this.#read(project, operation, input, state);
    if (operation === 'git-status') {
      try {
        const { stdout } = await this.runner('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--', '.'], {
          cwd: project.root, shell: false, windowsHide: true, timeout: (input.timeout_seconds ?? 20) * 1000, maxBuffer: 262144, encoding: 'utf8', signal,
          env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        });
        const snapshotId = this.#snapshot(state, { kind: 'git-status', text: stdout, source: { path: 'git:status', sha256: hash(stdout), read_at: now() } });
        return { status: 'passed', snapshot_id: snapshotId, source: state.snapshots[snapshotId].source, content: stdout, start_offset: 0, range_end: stdout.length, freshness: 'Fresh command output; not an atomic project snapshot and not a test result.' };
      } catch (error) { throw new Error(`Git status unavailable (${error.code ?? error.name}); the directory may not be a Git repository.`); }
    }
    if (operation === 'git-history') {
      // A direct call must neutralize external diff drivers and textconv filters itself, because no
      // backend rewrites this argv; .gitattributes must never decide to run a program here.
      const argv = gitHistoryCommand(input);
      try {
        const { stdout } = await this.runner('git', argv, {
          cwd: project.root, shell: false, windowsHide: true, timeout: (input.timeout_seconds ?? 20) * 1000, maxBuffer: 512 * 1024, encoding: 'utf8', signal,
          env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        });
        const snapshotId = this.#snapshot(state, { kind: 'git-history', text: stdout, source: { path: `git:${input.mode}`, sha256: hash(stdout), read_at: now() } });
        return { status: 'passed', mode: input.mode, ref: input.ref ?? null, snapshot_id: snapshotId, source: state.snapshots[snapshotId].source, content: stdout, start_offset: 0, range_end: stdout.length, freshness: 'Fresh command output for one fixed read-only Git subcommand; history is not a verification result.' };
      } catch (error) { throw new Error(`Git ${input.mode} unavailable (${error.code ?? error.name}); check the ref, the path and that this directory is a Git repository.`); }
    }
    throw new Error(`Unsupported operation for the generic adapter: ${operation}. Supported: begin, search, read, evidence, status, adjust-budget, git-status, git-history. help, workset and recall come from a project that ships tools/docs/context_session.py.`);
  }

  async #read(project, operation, input, state) {
    rejectSelectors(input, ['id', 'section', 'pointer', 'force', 'command_index', 'stream', 'limit']);
    if (typeof input.path !== 'string' || !input.path) throw new Error('The generic adapter requires a repository-relative path.');
    let snapshot, snapshotId = input.snapshot_id;
    if (snapshotId !== undefined) {
      snapshot = state.snapshots[snapshotId];
      if (!snapshot) throw new Error('Unknown or evicted snapshot_id; begin a fresh read explicitly.');
      if (snapshot.kind !== 'read' && snapshot.kind !== 'git-status') throw new Error('snapshot_id belongs to another operation.');
      if (snapshot.source.path !== input.path) throw new Error('snapshot_id does not match the requested path.');
    } else {
      const file = await readProjectFile(project, input.path);
      snapshot = { kind: 'read', ...file };
      snapshotId = this.#snapshot(state, snapshot);
    }
    if (input.expected_hash !== undefined && input.expected_hash !== snapshot.source.sha256) throw new Error('Source hash differs from expected_hash; inspect the change before continuing.');
    if (input.offset !== undefined && (input.start_line !== undefined || input.start_column !== undefined)) throw new Error('Use offset or start_line/start_column, not both.');
    const start = input.offset !== undefined ? integer(input.offset, 0, 0, snapshot.text.length, 'offset') : lineOffset(snapshot.text, integer(input.start_line, 1, 1, 1000000000, 'start_line'), integer(input.start_column, 1, 1, 1000000000, 'start_column'));
    let end = snapshot.text.length;
    if (input.end_line !== undefined) {
      const endLine = integer(input.end_line, undefined, 1, 1000000000, 'end_line');
      const lineStart = lineOffset(snapshot.text, endLine);
      const newline = snapshot.text.indexOf('\n', lineStart);
      end = newline < 0 ? snapshot.text.length : newline + 1;
      if (end < start) throw new Error('end_line precedes the requested start.');
    }
    return {
      status: 'passed', snapshot_id: snapshotId, source: snapshot.source, start_offset: start, range_end: end,
      content: snapshot.text.slice(start, Math.min(end, start + (input.max_chars ?? 4000))),
      freshness: input.snapshot_id ? 'Cached historical bytes; source has not been revalidated.' : 'Fresh file read; files are not an atomic project snapshot.',
      ...(operation === 'evidence' ? { verification: 'Historical report only; no commands, tests or verification have been rerun.' } : {}),
    };
  }

  async #search(project, input, state, signal) {
    rejectSelectors(input, ['include_stale', 'include_views', 'expected_hash']);
    if (typeof input.query !== 'string' || !input.query || input.query.length > 1000) throw new Error('query must contain 1 to 1000 characters.');
    const kind = input.kind ?? 'docs';
    if (!['docs', 'wiki'].includes(kind)) throw new Error('kind must be docs or wiki.');
    const prefix = input.path_prefix ? relativePath(input.path_prefix).replace(/\/$/, '') : '';
    if (prefix) {
      if (prefix.split('/').some(part => part.startsWith('.') || excludedDirectories.has(part.toLowerCase()))) throw new Error('path_prefix is excluded by the generic directory policy.');
    }
    const signature = JSON.stringify([input.query, kind, prefix]);
    let snapshotId = input.snapshot_id, snapshot;
    if (snapshotId !== undefined) {
      snapshot = state.snapshots[snapshotId];
      if (!snapshot || snapshot.kind !== 'search' || snapshot.signature !== signature) throw new Error('Unknown, evicted or mismatched search snapshot_id.');
    } else {
      if (prefix) await containedPath(project.root, prefix);
      let prefixes = kind === 'wiki' ? ['wiki', 'docs/wiki'] : [''];
      if (prefix) prefixes = prefixes.flatMap(scope => !scope || prefix === scope || prefix.startsWith(`${scope}/`) ? [prefix] : scope.startsWith(`${prefix}/`) ? [scope] : []);
      const enumeration = await listFiles(project, prefixes, signal);
      let scanned = 0, skipped = 0, bytes = 0, truncated = enumeration.truncated;
      const hits = [], query = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
      scan: for (const relative of enumeration.files) {
        if (signal?.aborted) throw new Error('Request cancelled.');
        let file;
        try { file = await readProjectFile(project, relative); } catch { skipped++; continue; }
        if (bytes + file.source.size_bytes > MAX_SCAN) { truncated = true; break; }
        scanned++; bytes += file.source.size_bytes;
        let lineNumber = 0;
        for (const line of file.text.split('\n')) {
          lineNumber++;
          const match = query.exec(line);
          if (!match) continue;
          const column = match.index;
          hits.push({ path: relative, line: lineNumber, column: column + 1, excerpt: line.slice(Math.max(0, column - 40), column + Math.min(input.query.length, 100) + 80).slice(0, 240), sha256: file.source.sha256, read_at: file.source.read_at });
          if (hits.length >= MAX_RESULTS) { truncated = true; break scan; }
        }
      }
      snapshot = { kind: 'search', signature, hits, scanned_files: scanned, skipped_files: skipped, scanned_bytes: bytes, scan_truncated: truncated, observed_at: now() };
      snapshotId = this.#snapshot(state, snapshot);
    }
    const offset = integer(input.offset, 0, 0, snapshot.hits.length, 'offset');
    const limit = integer(input.limit, 10, 1, 100, 'limit');
    return { status: 'passed', snapshot_id: snapshotId, offset, total_cached_hits: snapshot.hits.length,
      results: snapshot.hits.slice(offset, offset + limit), scanned_files: snapshot.scanned_files, skipped_files: snapshot.skipped_files,
      scanned_bytes: snapshot.scanned_bytes, scan_truncated: snapshot.scan_truncated,
      freshness: input.snapshot_id ? 'Cached historical hits; source files have not been revalidated.' : 'Per-file reads at different times; not an atomic project snapshot.',
    };
  }

  #response(project, operation, state, backend, maxChars, input) {
    const envelope = { project_id: project.id, adapter: 'generic', observed_at: now(), exit_code: backend.status === 'passed' ? 0 : 1,
      backend: { session_id: state.session_id, operation, ...backend },
      accounting: { unit: 'JSON UTF-16 code units', response_chars: 0, used_chars: state.used_chars, budget: state.budget, remaining_chars: Math.max(0, state.budget - state.used_chars), transport_excluded: true } };
    const body = envelope.backend;
    const refresh = () => {
      if (body.content !== undefined) {
        const snapshot = state.snapshots[body.snapshot_id];
        const consumed = body.start_offset + body.content.length;
        body.truncated = consumed < body.range_end;
        body.location = { start: location(snapshot.text, body.start_offset), end_exclusive: location(snapshot.text, consumed) };
        body.next_arguments = body.truncated ? { path: body.source.path, snapshot_id: body.snapshot_id, offset: consumed, ...(input.end_line !== undefined ? { end_line: input.end_line } : {}) } : null;
        if (operation === 'git-status' && body.truncated) body.continue_with = 'project_read';
      }
      if (body.results) {
        const next = body.offset + body.results.length;
        body.next_arguments = next < body.total_cached_hits ? { query: input.query, kind: input.kind ?? 'docs', ...(input.path_prefix ? { path_prefix: input.path_prefix } : {}), snapshot_id: body.snapshot_id, offset: next } : null;
      }
      // The accounting fields are part of the measured JSON; converge after digit changes.
      for (let iteration = 0; iteration < 8; iteration++) {
        const size = JSON.stringify(envelope).length;
        envelope.accounting.response_chars = size;
        envelope.accounting.used_chars = state.used_chars + size;
        envelope.accounting.remaining_chars = Math.max(0, state.budget - envelope.accounting.used_chars);
      }
    };
    refresh();
    while (JSON.stringify(envelope).length > maxChars) {
      const excess = JSON.stringify(envelope).length - maxChars;
      if (body.content?.length) body.content = body.content.slice(0, Math.max(0, body.content.length - excess - 24));
      else if (body.results?.length) body.results.pop();
      else if (body.recent_receipts?.length) body.recent_receipts.pop();
      else {
        envelope.backend = { session_id: state.session_id, operation, status: 'failed', error: 'max_chars is too small for this response metadata; retry with a larger max_chars.' };
        envelope.exit_code = 1;
        break;
      }
      refresh();
      if ((body.content !== undefined && body.content.length === 0 && body.start_offset < body.range_end) || (body.results && !body.results.length && body.offset < body.total_cached_hits)) {
        envelope.backend = { session_id: state.session_id, operation, status: 'failed', error: 'max_chars is too small to return one item; retry with a larger max_chars.' };
        envelope.exit_code = 1;
        break;
      }
    }
    if (operation !== 'adjust-budget' && operation !== 'status' && state.used_chars + JSON.stringify(envelope).length > state.budget) {
      envelope.backend = { session_id: state.session_id, operation, status: 'blocked', reason: 'Response would exceed remaining budget. Increase the same session budget and retry.' };
      envelope.exit_code = 1;
    }
    // Control/error responses are also counted, even when they exceed an exhausted budget.
    for (let iteration = 0; iteration < 8; iteration++) {
      const size = JSON.stringify(envelope).length;
      envelope.accounting.response_chars = size;
      envelope.accounting.used_chars = state.used_chars + size;
      envelope.accounting.remaining_chars = Math.max(0, state.budget - envelope.accounting.used_chars);
    }
    return envelope;
  }
}
