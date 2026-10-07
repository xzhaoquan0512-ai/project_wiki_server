import { evidenceSchema } from './lib/evidence-contract.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { ProjectAdapter, loadProjects } from './lib/project-adapter.mjs';

export function createProjectServer(projects, options = {}) {
  const server = new McpServer({ name: 'project-context-mcp', version: '0.3.0' }, {
    instructions: 'Read project_list and its adapter capabilities, begin a query session, then read applicable AGENTS.md rules completely. Reuse one session for a task. Generic adapters store query state outside project roots; context_session adapters use their own backend caches. Query tools do not edit source or run arbitrary commands. Follow next_arguments using the same snapshot_id for generic pagination; cached content is historical, not revalidated. Preserve freshness and verification limits.',
  });
  const adapter = new ProjectAdapter(projects, options.runner, options);
  const scope = { project_id: z.string().min(1).max(160) };
  const session = { ...scope, session_id: z.string().min(1).max(160) };
  const limit = { max_chars: z.number().int().min(1000).max(16000).optional() };
  const paging = { offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() };
  const lines = { start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional(), start_column: z.number().int().min(1).optional() };
  const snapshot = { snapshot_id: z.string().min(1).max(160).optional() };
  const expectedHash = { expected_hash: z.string().regex(/^[a-f0-9]{64}$/).optional() };
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  // Every tool states whether it changes project state, so a client can apply its own policy.
  // Creating a session and resizing its budget change session state; the query tools only read
  // project content, leaving the backend's own receipts and caches aside, the same convention the
  // knowledge tools already follow for reads that populate an extraction cache.
  const readOnly = new Set(['project_search', 'project_read', 'project_evidence', 'project_git_status', 'project_git_history', 'project_session_status', 'project_help', 'project_workset', 'project_recall', 'project_files', 'project_search_code', 'project_capture_evidence', 'project_check_evidence']);
  const register = (name, description, inputSchema, operation) => {
    server.registerTool(name, {
      description, inputSchema: z.object(inputSchema).strict(),
      annotations: { readOnlyHint: readOnly.has(name), destructiveHint: false, openWorldHint: false },
    }, async (input, extra) => {
      try {
        const value = await adapter.call(operation, input, extra.signal);
        return { ...result(value), isError: value.exit_code !== 0 || value.backend.status === 'failed' || value.backend.status === 'blocked' };
      } catch (error) { return { ...result({ error: error.message }), isError: true }; }
    });
  };
  server.registerTool('project_list', {
    description: 'List the explicitly registered engineering projects and their query adapter. Does not discover arbitrary directories.', inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => result([...projects.values()].map(p => ({ project_id: p.id, description: p.description, adapter: p.adapter === 'generic' ? 'generic' : 'context_session.py', capabilities: adapter.capabilities(p) }))));
  register('project_begin', 'Create a bookkeeping session for a new task. Read applicable AGENTS.md and adapter-specific rules. Generic supports query profile only. Existing tasks must reuse their session.', {
    ...scope, profile: z.enum(['query', 'engineering']).optional(), budget: z.number().int().min(8000).max(512000).optional(), ...limit,
  }, 'begin');
  register('project_search', 'Search engineering documents or Wiki according to project_list capabilities. Generic searches literal UTF-8 text and returns file hashes/line numbers; reuse snapshot_id and next_arguments for stable pages. include_stale/include_views are context_session-only.', {
    ...session, query: z.string().min(1).max(1000), kind: z.enum(['docs', 'wiki']).optional(),
    include_stale: z.boolean().optional(), include_views: z.boolean().optional(), path_prefix: z.string().optional(), ...paging, ...limit, ...snapshot,
  }, 'search');
  register('project_read', 'Read a repository-relative file. Generic returns paginated UTF-8 text, SHA-256 and line/column locations; offset is a UTF-16 character offset, with snapshot_id for cached continuation and expected_hash for change detection. ID/section/pointer/force/limit are context_session-only; that adapter defaults to a section outline. Follow continuation fields.', {
    ...session, path: z.string().optional(), id: z.string().optional(), section: z.string().optional(), pointer: z.string().optional(),
    force: z.boolean().optional(), ...lines, ...paging, ...limit, ...snapshot, ...expectedHash,
  }, 'read');
  register('project_evidence', 'Read existing evidence. Generic accepts UTF-8 report files with hash/location and snapshot_id continuation. context_session requires backend-supported RUN/EVD records; use project_read with pointer for ordinary JSON reports. command_index/stream/force/limit require context_session. Does not rerun tests or turn historical results into current verification.', {
    ...session, path: z.string().min(1), command_index: z.number().int().min(0).optional(), stream: z.enum(['stdout', 'stderr']).optional(),
    force: z.boolean().optional(), ...lines, ...paging, ...limit, ...snapshot, ...expectedHash,
  }, 'evidence');
  register('project_git_status', 'Capture a fresh, fixed read-only git status command through the project session. Reports current commit/branch and working-tree changes; it does not validate code or run tests. timeout_seconds defaults to 20; slow mounted projects may need up to 120. The client request timeout must exceed timeout_seconds plus the 10 seconds the service reserves to save the timeout receipt.', {
    ...session, ...limit, timeout_seconds: z.number().int().min(1).max(120).optional(),
  }, 'git-status');
  register('project_git_history', 'Read repository history through one fixed read-only Git subcommand: diff (optionally against one ref), log (bounded by entries, optionally one ref) or show (one ref, HEAD by default). One revision and at most one in-project path may be given; ranges, extra flags and external diff drivers are refused. Captures stop at max_bytes and report capture_status output_limit instead of truncating silently - narrow the request with ref/path, or read the saved capture with project_read. History explains changes; it is not a verification result.', {
    ...session, mode: z.enum(['diff', 'log', 'show']), ref: z.string().min(1).max(120).optional(),
    path: z.string().min(1).max(2048).optional(), entries: z.number().int().min(1).max(200).optional(),
    max_bytes: z.number().int().min(65_536).max(1_048_576).optional(),
    timeout_seconds: z.number().int().min(1).max(120).optional(), ...limit,
  }, 'git-history');
  register('project_session_status', 'Read query session usage and continuation state. This is not project completion or hardware health.', { ...session, ...limit }, 'status');
  register('project_help', 'Read the project backend\'s own bounded help for one of its subcommands inside this session, instead of guessing the protocol from the outside. Counts as session control output; it does not run the command it describes.', {
    ...session, command: z.string().min(1).max(60).optional(), ...paging, format: z.enum(['rows', 'blocks']).optional(), ...limit,
  }, 'help');
  register('project_workset', 'Ask the context_session backend to assemble a workset from a JSON spec that already lives inside the project. The service only checks that the spec path stays inside the project root; it does not read or interpret the spec, and keys select additional evidence.', {
    ...session, spec: z.string().min(1).max(4096), keys: z.array(z.string().min(1).max(160)).max(50).optional(), force: z.boolean().optional(), ...limit,
  }, 'workset');
  register('project_recall', 'Re-read one observation this session actually returned, by its receipt id. Historical observations are not current evidence unless the backend says so; re-reading does not rerun the recorded check.', {
    ...session, receipt: z.string().regex(/^OBS-[0-9]+-[0-9]+$/), pointer: z.string().min(1).max(500).optional(),
    ...lines, ...paging, format: z.enum(['rows', 'blocks']).optional(), force: z.boolean().optional(), ...limit,
  }, 'recall');
  register('project_files', 'Find permitted source/config/document paths in the whitelist project. Excludes credentials, links and build/dependency directories. Generic uses offset/limit; context_session returns a bounded capture to continue with project_read, and refuses offset/limit.', {
    ...session, query:z.string().max(1000).optional(), path_prefix:z.string().max(2048).optional(), ...paging, ...limit,
  },'files');
  register('project_search_code', 'Case-insensitive literal source/config/document search with line numbers. Generic provides hashes and offset/limit; context_session returns an accounted rg capture to continue with project_read. Fixed read-only scan captured by context_session; no caller-supplied executable or regex. A search that matches nothing returns no_matches with the command exit code instead of a tool failure, so an empty result is never mistaken for an error.', {
    ...session, query:z.string().min(1).max(1000), path_prefix:z.string().max(2048).optional(), ...paging, ...limit,
  },'search-code');
  register('project_capture_evidence', 'Capture full SHA-256 file identities plus commit, dirty state and time. Result is unverified evidence, not build or hardware acceptance. Context adapter stores the JSON in its accounted capture; generic returns a JSON text snapshot.', {
    ...session, paths:z.array(z.string().min(1).max(2048)).min(1).max(50), ...limit,
  },'capture-evidence');
  register('project_check_evidence', 'Re-read a captured evidence package on the project host. Returns unchanged/needs_review/inconclusive; does not update remote notes or rerun tests. Changed inputs require reassessing the conclusion.', {
    ...session, evidence:evidenceSchema, ...limit,
  },'check-evidence');
  register('project_prepare', 'Create the backend handoff template in its fixed query cache. Does not checkpoint or invent decisions. context_session only.', {
    ...session, goal:z.string().min(1).max(2000), paths:z.array(z.string().min(1).max(2048)).max(30).optional(), ...limit,
  },'prepare');
  register('project_checkpoint', 'Save an explicitly completed five-field handoff through a temporary file in the query cache. No caller-selected write path. Evidence hashes are backend 8-digit fingerprints, not full SHA-256. context_session only.', {
    ...session, summary:z.object({goal:z.string().min(1).max(2000),evidence:z.array(z.object({path:z.string().min(1).max(2048),sha256:z.string().regex(/^(?:[a-f0-9]{8})?$/),locator:z.string().max(2000)}).strict()).max(50),decisions:z.array(z.string().max(2000)).max(50),open_questions:z.array(z.string().max(2000)).max(50),next_actions:z.array(z.string().max(2000)).max(50)}).strict().refine(value=>JSON.stringify(value).length<=4000,'Handoff summary must not exceed 4000 characters'), ...limit,
  },'checkpoint');
  register('project_resume', 'Resume only after a real compacted/new-context event; reason is caller-declared, not platform-certified. Preserves history. Do not use to top up budget. context_session only.', {
    ...session, context_event:z.enum(['compacted','new-context']),context_reason:z.string().min(10).max(2000),...limit,
  },'resume');
  register('project_adjust_budget', 'Adjust the existing session budget with a concrete reason, retaining accumulated usage and receipts. Does not reset conversation or session history.', {
    ...session, budget: z.number().int().min(8000).max(512000), reason: z.string().min(10).max(1000), ...limit,
  }, 'adjust-budget');
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = process.argv[2];
    if (!config) throw new Error('Usage: node project-server.mjs /absolute/path/projects.json');
    const server = createProjectServer(await loadProjects(config));
    await server.connect(new StdioServerTransport());
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
