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
  const readOnly = new Set(['project_search', 'project_read', 'project_evidence', 'project_git_status', 'project_session_status']);
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
  register('project_session_status', 'Read query session usage and continuation state. This is not project completion or hardware health.', { ...session, ...limit }, 'status');
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
