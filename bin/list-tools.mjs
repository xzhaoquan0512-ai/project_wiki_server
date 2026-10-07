#!/usr/bin/env node
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initializeVault } from '../src/vault.mjs';
import { connectLocal } from '../src/client.mjs';

const base = await realpath(os.tmpdir());
const temporary = await mkdtemp(path.join(base, 'project-wiki-catalog-'));
try {
  const vault = await initializeVault(path.join(temporary, 'vault'));
  const config = path.join(temporary, 'projects.json');
  await writeFile(config, '{"projects":[]}\n');
  const catalog = {};
  for (const [name, command, location] of [['knowledge', 'wiki', vault], ['project', 'project', config]]) {
    const client = await connectLocal(command, location);
    try { catalog[name] = (await client.listTools()).tools; }
    finally { await client.close(); }
  }
  console.log(JSON.stringify(catalog, null, 2));
} finally {
  const resolved = await realpath(temporary);
  if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('project-wiki-catalog-')) throw new Error('Unexpected temporary path.');
  await rm(resolved, { recursive: true });
}
