#!/usr/bin/env node
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createWikiServer, createWikiTransport } from '../src/wiki-server.mjs';
import { createProjectServer } from '../src/project-server.mjs';
import { loadProjects } from '../src/lib/project-adapter.mjs';
import { initializeVault, resolveServicePath, serviceRoot } from '../src/vault.mjs';
import { lockStatus, recoverAbandonedLock } from '../src/lib/vault-admin.mjs';
import { startPanel } from '../src/panel-server.mjs';

const HELP = `project-wiki-server

Commands:
  init-vault [path]   Create a new empty knowledge vault; never overwrite
  wiki [path]         Start knowledge MCP on stdio
  project [config]    Start project MCP on stdio
  panel [path]        Start the local read-only admin panel over HTTP (no note editing)
  lock-status [path]  Inspect vault writer lock
  recover-lock [path] Recover a lock only after its local owner has exited

Panel options:
  --port=N            Listen port, 0 picks a free port (default 8790)
  --host=ADDR         Bind address (default 127.0.0.1)
  --allow-remote      Permit a non-loopback bind; the panel has no authentication

Environment (all paths must be absolute):
  PROJECT_WIKI_VAULT       Default vault (otherwise data/vault under service directory)
  PROJECT_WIKI_CONFIG      Default project registry (otherwise config/projects.json)
  PROJECT_WIKI_STATE       Generic query sessions (must be outside registered projects)
  PROJECT_WIKI_LIBREOFFICE Absolute soffice executable for legacy .doc/.ppt conversion
  PROJECT_WIKI_MAX_SOURCE_MIB Source limit, 1..64 MiB (default 20)

No command deploys to a remote host or registers an external project automatically.`;

// Only these options take a separate value; every other --flag is a boolean switch.
const VALUE_OPTIONS = new Set(['port', 'host']);
const PANEL_OPTIONS = new Set(['port', 'host', 'allow-remote']);
const DEFAULT_PANEL_PORT = 8790;

const argv = process.argv.slice(2);
const options = new Map();
const positional = [];

try {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(argument);
    if (!match) {
      if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}. Use --help for usage.`);
      positional.push(argument);
      continue;
    }
    const [, name, inline] = match;
    if (options.has(name)) throw new Error(`Duplicate option: --${name}.`);
    if (inline !== undefined) { options.set(name, inline); continue; }
    if (!VALUE_OPTIONS.has(name)) { options.set(name, ''); continue; }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`Option --${name} needs a value, for example --${name}=8790.`);
    options.set(name, next); index++;
  }

  const [command, location, ...extra] = positional;
  if (extra.length) throw new Error('Too many arguments. Use --help for usage.');
  const allowed = command === 'panel' ? PANEL_OPTIONS : new Set();
  for (const name of options.keys()) if (!allowed.has(name)) throw new Error(`Unknown option: --${name}. Use --help for usage.`);

  const vaultPath = () => resolveServicePath({
    argument: location, environment: process.env.PROJECT_WIKI_VAULT,
    fallback: path.join(serviceRoot, 'data/vault'), variable: 'PROJECT_WIKI_VAULT',
  });

  if (!command) {
    console.log(HELP);
  } else if (command === 'lock-status' || command === 'recover-lock') {
    const vault = vaultPath();
    console.log(JSON.stringify(await (command === 'lock-status' ? lockStatus(vault) : recoverAbandonedLock(vault)), null, 2));
  } else if (command === 'init-vault' || command === 'wiki') {
    const vault = vaultPath();
    if (command === 'init-vault') console.log(`Created empty vault: ${await initializeVault(vault)}`);
    else await (await createWikiServer(vault)).connect(createWikiTransport());
  } else if (command === 'project') {
    const config = resolveServicePath({
      argument: location, environment: process.env.PROJECT_WIKI_CONFIG,
      fallback: path.join(serviceRoot, 'config/projects.json'), variable: 'PROJECT_WIKI_CONFIG',
    });
    await createProjectServer(await loadProjects(config)).connect(new StdioServerTransport());
  } else if (command === 'panel') {
    const rawPort = options.get('port');
    const port = rawPort === undefined || rawPort === '' ? DEFAULT_PANEL_PORT : Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535.');
    const host = options.get('host') || '127.0.0.1';
    const allowRemote = options.has('allow-remote');
    const panel = await startPanel(vaultPath(), { port, host, allowRemote });
    console.log([
      `Knowledge panel listening on ${panel.url}`,
      `Vault: ${panel.root}`,
      `Mode: read-only queries plus confirmed maintenance actions (rebuild index, recover lock).`,
      `Not provided: note editing, source import, arbitrary commands.`,
      allowRemote ? `WARNING: bound to ${host} without authentication; anyone who can reach this port can read the vault.` : `Bound to ${host}: only this machine can reach it.`,
      `Press Ctrl+C to stop.`,
    ].join('\n'));
    const stop = () => { panel.close().then(() => process.exit(0)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
