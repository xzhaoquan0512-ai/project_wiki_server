import { createHash } from 'node:crypto';
import { readProjectFile } from './generic-project-adapter.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GenericProjectAdapter, genericCapabilities } from './generic-project-adapter.mjs';
import { relativePath, containedPath } from './project-paths.mjs';
import { gitHistoryArgv } from './git-history.mjs';
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
      operations: ['begin', 'search', 'read', 'evidence', 'status', 'adjust-budget', 'git-status', 'git-history', 'help', 'workset', 'recall', 'files', 'search-code', 'capture-evidence', 'check-evidence', 'prepare', 'checkpoint', 'resume'],
      search: 'project_search uses backend docs|wiki indexes. project_files and project_search_code run fixed literal rg queries via backend captures; rg must be installed. Continue captures with project_read.',
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
    const allowed = ['begin', 'search', 'read', 'evidence', 'status', 'adjust-budget', 'git-status', 'git-history', 'help', 'workset', 'recall', 'files', 'search-code', 'capture-evidence', 'check-evidence', 'prepare', 'checkpoint', 'resume'];
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

  // One request file per call: unique so parallel MCP processes cannot read each other's argv,
  // and removed by the caller as soon as the backend has read it.
  async #requestFile(project, name, argv) {
    const base = await containedPath(project.root, `build/docs/mcp/argv/${name}.json`, true);
    await mkdir(path.dirname(base), { recursive: true });
    await containedPath(project.root, `build/docs/mcp/argv/${name}.json`, true);
    const unique = base.replace(/\.json$/, `-${process.pid}-${randomUUID()}.json`);
    await writeFile(unique, JSON.stringify(argv) + '\n', { flag: 'wx' });
    return unique;
  }

  async #run(project, operation, input, signal) {
    if (signal?.aborted) throw new Error('Request cancelled.');
    if (['capture-evidence', 'check-evidence'].includes(operation)) {
      const deadline = AbortSignal.timeout(130000);
      signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    }
    if (project.adapter === 'generic') return this.generic.call(project, operation, input, signal);
    if (input.snapshot_id !== undefined || input.expected_hash !== undefined) {
      throw new Error('snapshot_id and expected_hash are supported only by the generic adapter.');
    }
    if (['capture-evidence','check-evidence'].includes(operation)) return this.#evidence(project, operation, input, signal);
    // Both Git tools hand the backend one fixed argv file and drive its `run` subcommand.
    const observation = ['files','search-code'].includes(operation);
    const gitOperation = operation === 'git-status' || operation === 'git-history' || observation;
    const args = [project.script, gitOperation ? 'run' : operation, `--root=${project.root}`];
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
    } else if (gitOperation) {
      let argv;
      if (observation) {
        if(input.offset!==undefined||input.limit!==undefined)throw Error('context_session search returns a bounded capture; continue it with project_read. offset/limit are generic-only.');
        const prefix=input.path_prefix?relativePath(input.path_prefix):'.';await containedPath(project.root,prefix);
        const globs=[...genericCapabilities.excluded_directories.map(name=>`!**/${name}/**`),'!.*','!**/.*','!*password*','!*secret*','!*credential*','!*id_rsa*','!*id_ed25519*','!*.pem','!*.key','!*.p12','!*.pfx'];
        argv=operation==='files'?['rg','--files']:['rg','--json','--line-number','--fixed-strings','--ignore-case'];
        if(operation==='files'&&input.query) {if(/[\[\]{}*?]/.test(input.query))throw Error('Filename query must be literal, without glob metacharacters.');argv.push('--iglob',`*${input.query}*`);}
        // Exclusions come last: rg uses the last matching glob, so a filename query must
        // never re-include a credential or generated-directory file.
        for(const glob of globs)argv.push('--iglob',glob);
        argv.push('--',...(operation==='search-code'?[input.query]:[]),prefix);
      }
      else if (operation === 'git-status') argv = ['git', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'];
      else {
        // The path may name a file that no longer exists in the work tree but still has history,
        // so containment is verified against the nearest existing ancestor.
        if (input.path !== undefined) await containedPath(project.root, input.path, true);
        argv = gitHistoryArgv(input);
      }
      // Use a unique file per call so separate MCP processes cannot race its contents. The
      // backend copies the argv into its own capture directory, so the request file itself is
      // removed after the call instead of accumulating one file per query in the project.
      disposable = await this.#requestFile(project, operation === 'git-status' ? 'git-status' : 'git-history', argv);
      option(args, 'argv-file', path.relative(project.root, disposable).replaceAll('\\', '/'));
      option(args, 'timeout', input.timeout_seconds ?? 20);
      // A repository-wide diff can exceed the default capture size; the backend then reports
      // capture_status output_limit instead of truncating silently, and the caller may raise it.
      option(args, 'max-bytes', operation === 'git-history' ? (input.max_bytes ?? 262144) : 262144);
    } else if (operation === 'prepare') {
      option(args,'goal',input.goal);
      for(const value of input.paths??[]) {await containedPath(project.root,value);option(args,'path',relativePath(value));}
      // Caller cannot choose an arbitrary output path; backend owns its documented cache.
    } else if (operation === 'checkpoint') {
      for(const evidence of input.summary.evidence)await containedPath(project.root,evidence.path);
      const relative=`build/docs/mcp/handoffs/${input.session_id}-${randomUUID()}.json`;
      const filename=await containedPath(project.root,relative,true);
      await mkdir(path.dirname(filename),{recursive:true});await containedPath(project.root,relative,true);
      await writeFile(filename,JSON.stringify(input.summary)+'\n',{flag:'wx'});
      disposable=filename;option(args,'summary-file',relative);
    } else if (operation === 'resume') {
      option(args,'context-event',input.context_event);option(args,'context-reason',input.context_reason);
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
          timeout: gitOperation ? ((input.timeout_seconds ?? 20) + 10) * 1000 : 30000,
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
      if(observation && data.result?.exit_code===1 && data.result?.complete && data.result?.stdout?.bytes===0) {data.status='passed';data.result.no_matches=true;data.result.command_exit_code=1;exitCode=0;}
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
  async #evidence(project, operation, input, signal) {
    if(operation==='check-evidence'&&input.evidence.project_id!==project.id)throw Error('Evidence belongs to another project.');
    const receipts=[];
    const git=async()=>{
      const r=await this.#run(project,'git-status',{...input,max_chars:2000},signal);receipts.push(r.backend.receipt_id);
      if(r.exit_code!==0||r.backend.status!=='passed'||!r.backend.result?.complete)throw Error('Git evidence capture incomplete.');
      const cap=r.backend.result.capture_id;
      if(!/^CAP-[A-Za-z0-9-]+$/.test(cap))throw Error('Invalid backend capture identity.');
      const output=await readFile(await containedPath(project.root,`build/docs/context-output/${input.session_id}/${cap}/stdout.txt`),'utf8');
      return {commit:output.match(/^# branch\.oid ([a-f0-9]+)$/m)?.[1]??null,dirty:output.split('\n').some(l=>l&&!l.startsWith('#')),workspace_fingerprint:createHash('sha256').update(output).digest('hex')};
    };
    const before=await git(),files=[];
    for(const previous of operation==='capture-evidence'?input.paths.map(path=>({path})):input.evidence.files) {
      try {
        const r=await this.#run(project,'read',{...input,path:previous.path,start_line:1,end_line:1,max_chars:2000},signal);receipts.push(r.backend.receipt_id);
        if(r.exit_code!==0||r.backend.status!=='passed')throw Error('Backend source read failed.');
        const f=await readProjectFile(project,previous.path);
        if(!f.source.sha256.startsWith(r.backend.result.sha256))throw Error('File changed between backend observation and full digest capture.');
        files.push({...f.source,hash_algorithm:'sha256',...(previous.sha256?{expected_sha256:previous.sha256,changed:f.source.sha256!==previous.sha256}:{})});
      }catch(error){if(operation==='capture-evidence')throw error;files.push({path:previous.path,changed:true,error:error.message});}
    }
    const after=await git(),changedDuring=before.workspace_fingerprint!==after.workspace_fingerprint||before.commit!==after.commit;
    const changed=operation==='check-evidence'&&(files.some(f=>f.changed)||input.evidence.commit!==after.commit||input.evidence.dirty!==after.dirty||input.evidence.workspace_fingerprint!==after.workspace_fingerprint);
    const evidence={version:1,project_id:project.id,observed_at:new Date().toISOString(),...after,files,hash_algorithm:'sha256',changed_during_capture:changedDuring,
      verification:'unverified',warning:'Per-file observations bound to backend receipts, not an atomic snapshot or build/hardware validation.'};
    const value={project_id:project.id,exit_code:0,backend:{status:'passed',session:input.session_id,result:operation==='capture-evidence'?evidence:{...evidence,status:changedDuring?'inconclusive':changed?'needs_review':'unchanged'}},receipts,accounting:'Backend calls retain their session charges; this full-hash metadata envelope is additional MCP output.'};
    if(JSON.stringify(value).length>(input.max_chars??4000))throw Error('Evidence response exceeds max_chars; increase it or request fewer files. Backend observations remain recorded.');
    return value;
  }

}
