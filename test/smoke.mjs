import assert from 'node:assert/strict';
import path from 'node:path';
import { serviceRoot } from '../src/vault.mjs';
import { connectLocal, callJson } from '../src/client.mjs';

const vault = path.resolve(process.env.PROJECT_WIKI_VAULT ?? path.join(serviceRoot, 'data/vault'));
const config = path.resolve(process.env.PROJECT_WIKI_CONFIG ?? path.join(serviceRoot, 'config/projects.json'));
const report = { passed: false, checks: [] };
try {
  const wiki = await connectLocal('wiki', vault);
  try {
    const tools = (await wiki.listTools()).tools;
    assert.equal(tools.length, 29);
    for (const name of ['wiki_read_source', 'wiki_check_sources', 'wiki_note_history', 'wiki_restore_note', 'wiki_rename_note', 'wiki_merge_notes', 'wiki_archive_note', 'wiki_rebuild_index', 'wiki_read_log', 'wiki_ops_status']) {
      assert.ok(tools.some(tool => tool.name === name), `Missing knowledge tool: ${name}`);
    }
    const rules = await wiki.readResource({ uri: 'wiki://rules' });
    assert.ok(rules.contents[0].text.length > 0);
    const status = await callJson(wiki, 'wiki_status');
    report.checks.push({ service: 'knowledge', tools: tools.map(tool => tool.name), notes: status.notes.total, raw_sources: status.sources.totalRaw });
  } finally { await wiki.close(); }
  const project = await connectLocal('project', config);
  try {
    const tools = (await project.listTools()).tools;
    assert.equal(tools.length, 19);
    const projects = await callJson(project, 'project_list');
    assert.ok(Array.isArray(projects));
    report.checks.push({ service: 'project', tools: tools.map(tool => tool.name), registered_projects: projects.length });
  } finally { await project.close(); }
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
console.log(JSON.stringify(report, null, 2));
