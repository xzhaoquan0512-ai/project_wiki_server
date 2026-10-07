import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GenericProjectAdapter, genericCapabilities } from './generic-project-adapter.mjs';
import { relativePath, containedPath } from './project-paths.mjs';
export { relativePath, containedPath } from './project-paths.mjs';

const execute = promisify(execFile);
const safeId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;

export async function loadProjects(configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!Array.isArray(config.projects)) throw new Error('Project configuration must contain a projects array.');
  const projects = new Map();
  for (const item of config.projects) {
    if (!safeId.test(item.id ?? '') || projects.has(item.id)) throw new Error('Project IDs must be unique safe identifiers.');
    if (typeof item.root !== 'string' || !path.isAbsolute(item.root)) throw new Error('Project roots must be absolute paths.');
    const root = await realpath(item.root);
    if (!(await stat(root)).isDirectory()) throw new Error('Project root must be a directory.');
    const requestedAdapter = item.adapter ?? 'auto';
    if (!['auto', 'generic', 'context_session'].includes(requestedAdapter)) throw new Error('adapter must be auto, generic or context_session.');
    let script;
    if (requestedAdapter !== 'generic') {
      try {
        script = await containedPath(root, 'tools/docs/context_session.py');
        if (!(await stat(script)).isFile()) throw new Error('context_session.py must be a regular file.');
      } catch (error) {
        if (requestedAdapter === 'context_session' || error.code !== 'ENOENT') throw error;
      }
    }
    const adapter = script ? 'context_session' : 'generic';
    if (item.python !== undefined && (typeof item.python !== 'string' || !item.python.trim())) throw new Error('python must be an executable name or path.');
    const python = item.python ?? (process.platform === 'win32' ? 'python' : 'python3');
    projects.set(item.id, { id: item.id, root, adapter, script, python, description: item.description ?? '' });
  }
  return projects;
}

function option(args, flag, value) {
  if (value !== undefined) args.push(`--${flag}=${String(value)}`);
}

export class ProjectAdapter {
  #queues = new Map();
  constructor(projects, runner = execute, options = {}) {
    this.projects = projects; this.runner = runner;
    this.generic = new GenericProjectAdapter(projects, { ...options, runner });
  }

  capabilities(project) {
    return project.adapter === 'generic' ? genericCapabilities : {
      backend: 'context_session.py', selectors: ['path', 'id', 'section', 'pointer', 'lines', 'command_index', 'stream'],
      operations: ['begin', 'search', 'read', 'evidence', 'status', 'adjust-budget', 'git-status', 'help', 'workset', 'recall'],
      search: 'kind docs|wiki exactly as the backend defines them; the service forwards no selector the backend CLI does not accept, so source-code coverage follows the backend index rather than this service',
      session_storage: 'project backend query cache', freshness: 'preserves backend freshness and confidence',
    };
  }

  project(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error('Unknown project_id; call project_list first.');
    return project;
  }

  async call(operation, input, signal) {
    const project = this.project(input.project_id);
    const allowed = ['begin', 'search', 'read', 'evidence', 'status', 'adjust-budget', 'git-status', 'help', 'workset', 'recall'];
    if (!allowed.includes(operation)) throw new Error('Unsupported operation.');
    if (operation === 'git-status' && input.timeout_seconds !== undefined &&
        (!Number.isInteger(input.timeout_seconds) || input.timeout_seconds < 1 || input.timeout_seconds > 120)) {
      throw new Error('timeout_seconds must be an integer from 1 to 120.');
    }
    if (operation !== 'begin' && !safeId.test(input.session_id ?? '')) throw new Error('A valid session_id is required.');
    // Calls sharing a project/session must not race the backend's bookkeeping lock.
    const key = `${project.id}:${input.session_id ?? 'begin'}`;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.#run(project, operation, input, signal));
    this.#queues.set(key, current);
    try { return await current; }
    finally { if (this.#queues.get(key) === current) this.#queues.delete(key); }
  }

  async #run(project, operation, input, signal) {
    if (signal?.aborted) throw new Error('Request cancelled.');
    if (project.adapter === 'generic') return this.generic.call(project, operation, input, signal);
    if (input.snapshot_id !== undefined || input.expected_hash !== undefined) {
      throw new Error('snapshot_id and expected_hash are supported only by the generic adapter.');
    }
    const args = [project.script, operation === 'git-status' ? 'run' : operation, `--root=${project.root}`];
    // A per-call request file handed to the backend; it is removed once the call is over.
    let disposable = '';
    if (operation !== 'begin') option(args, 'session', input.session_id);
    option(args, 'max-chars', input.max_chars ?? (operation === 'search' ? 3000 : 4000));
    if (operation === 'begin') {
      option(args, 'profile', input.profile ?? 'query');
      option(args, 'budget', input.budget);
    } else if (operation === 'adjust-budget') {
      option(args, 'budget', input.budget);
      option(args, 'reason', input.reason);
    } else if (operation === 'git-status') {
      const argvPath = await containedPath(project.root, 'build/docs/mcp/argv/git-status.json', true);
      await mkdir(path.dirname(argvPath), { recursive: true });
      await containedPath(project.root, 'build/docs/mcp/argv/git-status.json', true);
      const argv = ['git', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'];
      // Use a unique file per call so separate MCP processes cannot race its contents. The
      // backend copies the argv into its own capture directory, so the request file itself is
      // removed after the call instead of accumulating one file per query in the project.
      const uniquePath = argvPath.replace(/\.json$/, `-${process.pid}-${randomUUID()}.json`);
      await writeFile(uniquePath, JSON.stringify(argv) + '\n', { flag: 'wx' });
      disposable = uniquePath;
      option(args, 'argv-file', path.relative(project.root, uniquePath).replaceAll('\\', '/'));
      option(args, 'timeout', input.timeout_seconds ?? 20);
      option(args, 'max-bytes', 262144);
    } else if (operation === 'help') {
      option(args, 'command', input.command);
      option(args, 'offset', input.offset);
      option(args, 'limit', input.limit);
      option(args, 'format', input.format);
    } else if (operation === 'workset') {
      // The spec is a JSON file inside the project: the backend reads it, this service only
      // checks that an existing path cannot escape the registered root.
      try { await containedPath(project.root, input.spec); }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error('The workset spec must be an existing repository-relative JSON file.');
        throw error;
      }
      option(args, 'spec', relativePath(input.spec));
      for (const key of input.keys ?? []) option(args, 'key', key);
      if (input.force) args.push('--force');
    } else if (operation === 'recall') {
      option(args, 'receipt', input.receipt);
      option(args, 'pointer', input.pointer);
      for (const [field, flag] of Object.entries({
        start_line: 'start-line', end_line: 'end-line', start_column: 'start-column',
        offset: 'offset', limit: 'limit', format: 'format',
      })) option(args, flag, input[field]);
      if (input.force) args.push('--force');
    } else if (operation === 'search') {
      option(args, 'kind', input.kind ?? 'docs');
      option(args, 'query', input.query);
      option(args, 'offset', input.offset);
      option(args, 'limit', input.limit ?? 2);
      if (input.path_prefix) option(args, 'path-prefix', relativePath(input.path_prefix));
      if (input.include_stale) args.push('--include-stale');
      if (input.include_views) args.push('--include-views');
    } else if (operation === 'read' || operation === 'evidence') {
      if (operation === 'read' && Number(Boolean(input.path)) + Number(Boolean(input.id)) !== 1) {
        throw new Error('Provide exactly one of path or id.');
      }
      if (operation === 'evidence' && !input.path) throw new Error('Evidence requires a repository-relative path.');
      if (input.path) {
        await containedPath(project.root, input.path);
        option(args, 'path', relativePath(input.path));
      }
      option(args, 'id', input.id);
      for (const [field, flag] of Object.entries({
        section: 'section', pointer: 'pointer', start_line: 'start-line', end_line: 'end-line',
        start_column: 'start-column', offset: 'offset', limit: 'limit',
        command_index: 'command-index', stream: 'stream',
      })) option(args, flag, input[field]);
      if (input.force) args.push('--force');
    }

    try {
      let stdout, stderr = '', exitCode = 0;
      try {
        ({ stdout, stderr } = await this.runner(project.python, args, {
          cwd: project.root, shell: false, windowsHide: true,
          // Leave time for the backend to save its timeout receipt and captured streams.
          timeout: operation === 'git-status' ? ((input.timeout_seconds ?? 20) + 10) * 1000 : 30000,
          maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', signal,
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', GIT_OPTIONAL_LOCKS: '0' },
        }));
      } catch (error) {
        if (typeof error.stdout !== 'string' || !error.stdout.trim()) {
          if (error.code === 'ENOENT') {
            throw new Error(`Project query process failed (ENOENT). Check Python executable ${JSON.stringify(project.python)} and the project root. Install Python 3 or set python in the project configuration to its executable name or absolute path.`);
          }
          throw new Error(`Project query process failed (${error.code ?? error.name}).`);
        }
        stdout = error.stdout;
        stderr = error.stderr ?? '';
        exitCode = Number.isInteger(error.code) ? error.code : 1;
      }
      let data;
      try { data = JSON.parse(stdout); }
      catch { throw new Error('Project backend did not return a complete JSON response.'); }
      return {
        project_id: project.id, observed_at: new Date().toISOString(), exit_code: exitCode,
        backend: data, ...(stderr.trim() ? { diagnostic: stderr.trim().slice(0, 1200) } : {}),
        ...(operation === 'begin' ? { next_step: 'Read AGENTS.md and docs/maintenance/ai/wiki-usage.md with project_read using this session; continue with the fields that response actually returned (a read/search outline with next_offset, or next_line/next_column for captured output). Reuse the session for this task.' } : {}),
        accounting: 'Backend session budgets cover backend JSON only; this MCP envelope and transport overhead are additional.',
      };
    } finally {
      // The backend reads this file while starting the command; a cancelled, timed out or failed
      // call must still not leave request files behind in the project.
      if (disposable) await rm(disposable, { force: true }).catch(() => {});
    }
  }
}
