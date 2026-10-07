#!/usr/bin/env node
import { mkdtemp, mkdir, cp, writeFile, readFile, realpath, rm, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { serviceRoot } from '../src/vault.mjs';

const execute = promisify(execFile);

// The platform `tar` cannot express what the bundle needs: Windows tar.exe supports neither --mode nor -s
// and NTFS ignores POSIX bits, so every entry would ship as 0666/0777. Python's tarfile writes them exactly.
// Node files stay 0644; shell scripts 0755 so `./start-wiki.sh` works as well as `bash start-wiki.sh`.
const ARCHIVE_SCRIPT = `
import os, sys, tarfile
root, target = sys.argv[1], sys.argv[2]
if not os.path.isdir(root):
    raise SystemExit('staging directory is missing: ' + root)
for unsafe in ('.git', 'node_modules', 'data'):
    if os.path.exists(os.path.join(root, unsafe)):
        raise SystemExit('refusing to bundle ' + unsafe)
with tarfile.open(target, 'w:gz') as archive:
    for base, directories, files in os.walk(root):
        directories.sort()
        files.sort()
        relative = os.path.relpath(base, root)
        if relative == '.':
            relative = ''
        for name in sorted(directories):
            full = os.path.join(base, name)
            info = archive.gettarinfo(full, os.path.join(relative, name))
            info.mode = 0o755
            archive.addfile(info)
        for name in files:
            full = os.path.join(base, name)
            info = archive.gettarinfo(full, os.path.join(relative, name))
            info.mode = 0o755 if name.endswith('.sh') else 0o644
            with open(full, 'rb') as handle:
                archive.addfile(info, handle)
`;

const base = await realpath(os.tmpdir());
const staging = await mkdtemp(path.join(base, 'project-wiki-bundle-'));
try {
  // Explicit allowlist; runtime data, local configuration and node_modules never enter the bundle.
  const included = ['package.json', 'package-lock.json', 'README.md', 'AGENTS.md', 'bin', 'src', 'test', 'templates', 'deploy', 'examples'];
  for (const name of included) await cp(path.join(serviceRoot, name), path.join(staging, name), { recursive: true });
  await mkdir(path.join(staging, 'config'));
  await writeFile(path.join(staging, 'config/projects.json'), '{"projects":[]}\n');
  await cp(path.join(serviceRoot, 'config/projects.example.json'), path.join(staging, 'config/projects.example.json'));
  const dist = path.join(serviceRoot, 'dist');
  await mkdir(dist, { recursive: true });
  const target = path.join(dist, 'project-wiki-server.tar.gz');
  // Build beside the target and rename, so a failed run never leaves a half-written artifact in place.
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    let lastError;
    for (const interpreter of ['python', 'python3']) {
      try {
        await execute(interpreter, ['-c', ARCHIVE_SCRIPT, staging, temporary], { shell: false, windowsHide: true, timeout: 60000 });
        lastError = undefined; break;
      } catch (error) {
        // Only a missing interpreter is retried; a real archiving failure must surface as-is.
        if (error.code !== 'ENOENT') throw error;
        lastError = error;
      }
    }
    if (lastError) throw new Error('Bundling needs Python 3 (tried python and python3): the platform tar cannot set archive modes.');
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  const sha256 = createHash('sha256').update(await readFile(target)).digest('hex');
  await writeFile(`${target}.sha256`, `${sha256}  project-wiki-server.tar.gz\n`);
  console.log(JSON.stringify({ artifact: target, sha256, includes_data: false, registered_projects: 0 }, null, 2));
} finally {
  const resolved = await realpath(staging);
  if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('project-wiki-bundle-')) throw new Error('Unexpected staging path.');
  await rm(resolved, { recursive: true });
}
