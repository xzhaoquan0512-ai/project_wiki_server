import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
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
    projects.set(item.id, { id: item.id, root, adapter, script, python: item.python ?? 'python', description: item.description ?? '' });
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
    const allowed = ['begin', 'search', 'read', 'evidence', 'status', 'adjust-budget', 'git-status'];
    if (!allowed.includes(operation)) throw new Error('Unsupported operation.');
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
      // Use a unique file per call so separate MCP processes cannot race its contents.
      const uniquePath = argvPath.replace(/\.json$/, `-${process.pid}-${randomUUID()}.json`);
      await writeFile(uniquePath, JSON.stringify(argv) + '\n', { flag: 'wx' });
      option(args, 'argv-file', path.relative(project.root, uniquePath).replaceAll('\\', '/'));
      option(args, 'timeout', 20);
      option(args, 'max-bytes', 262144);
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

    let stdout, stderr = '', exitCode = 0;
    try {
      ({ stdout, stderr } = await this.runner(project.python, args, {
        cwd: project.root, shell: false, windowsHide: true, timeout: 30000,
        maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', signal,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', GIT_OPTIONAL_LOCKS: '0' },
      }));
    } catch (error) {
      if (typeof error.stdout !== 'string' || !error.stdout.trim()) {
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
      ...(operation === 'begin' ? { next_step: 'Read AGENTS.md and docs/maintenance/ai/wiki-usage.md with project_read using this session; follow next_line/next_column until complete. Reuse the session for this task.' } : {}),
      accounting: 'Backend session budgets cover backend JSON only; this MCP envelope and transport overhead are additional.',
    };
  }
}
