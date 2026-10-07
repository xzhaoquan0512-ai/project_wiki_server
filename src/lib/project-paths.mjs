import { realpath } from 'node:fs/promises';
import path from 'node:path';

export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f:]/.test(value)) {
    throw new Error('Expected a repository-relative path.');
  }
  const normalized = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error('Paths must remain inside the registered project.');
  }
  if (normalized.split('/').some(part => part !== '.' && (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
    throw new Error('Paths must use portable file names, not reserved device names.');
  }
  return normalized;
}

export async function containedPath(root, value, allowMissing = false) {
  const normalized = relativePath(value);
  const target = path.resolve(root, normalized);
  let probe = target;
  while (true) {
    try {
      const resolved = await realpath(probe);
      if (!inside(root, resolved)) throw new Error('Path resolves outside the registered project.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing || probe === root) throw error;
      probe = path.dirname(probe);
    }
  }
  return target;
}
