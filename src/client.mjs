import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serviceRoot } from './vault.mjs';

export async function connectLocal(command, location, { env } = {}) {
  const client = new Client({ name: 'project-wiki-server-check', version: '0.3.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(serviceRoot, 'bin/project-wiki-server.mjs'), command, ...(location === undefined ? [] : [location])],
    cwd: serviceRoot, stderr: 'pipe', env: { ...process.env, ...env },
  });
  let diagnostic = '';
  transport.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
  try { await client.connect(transport); }
  catch (error) {
    await client.close().catch(() => {});
    throw new Error(`${error.message}${diagnostic ? `\n${diagnostic}` : ''}`);
  }
  return client;
}

export async function callJson(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}
