import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolve a command-line location or environment default.
 * An explicit argument resolves against the caller's working directory; an environment default must be
 * absolute so it cannot follow the MCP client's working directory or land inside a registered project.
 */
export function resolveServicePath({ argument, environment, fallback, variable }) {
  if (argument !== undefined) return path.resolve(argument);
  const fromEnvironment = environment === undefined || environment === '' ? undefined : environment;
  if (fromEnvironment === undefined) return path.resolve(fallback);
  if (typeof fromEnvironment !== 'string' || !path.isAbsolute(fromEnvironment)) {
    throw new Error(`${variable} must be an absolute path; relative values would resolve against the MCP client's working directory.`);
  }
  return path.resolve(fromEnvironment);
}

export async function initializeVault(directory) {
  const root = path.resolve(directory);
  try {
    await lstat(root);
    throw new Error('Target already exists. Choose a new directory; existing vaults are never overwritten.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(root), { recursive: true });
  // mkdir without recursive on the target prevents a competing initializer from reusing it.
  await mkdir(root);
  for (const folder of ['raw', 'wiki/concepts', 'wiki/entities', 'wiki/syntheses']) {
    await mkdir(path.join(root, folder), { recursive: true });
  }
  const rules = await readFile(path.join(serviceRoot, 'templates/vault/AGENTS.md'), 'utf8');
  await writeFile(path.join(root, 'AGENTS.md'), rules, { flag: 'wx' });
  await writeFile(path.join(root, 'wiki/index.md'), '# Wiki Index\n\n此目录由知识工具维护；整理笔记后自动更新，也可显式重建。\n\n<!-- LLMWIKI_INDEX_START -->\n\n<!-- LLMWIKI_INDEX_END -->\n', { flag: 'wx' });
  await writeFile(path.join(root, 'wiki/log.md'), '# Wiki Log\n\n仅记录实际发生的知识整理与维护操作。\n', { flag: 'wx' });
  return root;
}
