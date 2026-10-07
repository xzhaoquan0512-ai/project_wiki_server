import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readProjectFile, listFiles } from './generic-project-adapter.mjs';
import { relativePath } from './project-paths.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function gitState(project, signal) {
  const { stdout } = await promisify(execFile)('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'], {
    cwd: project.root, shell: false, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024, encoding: 'utf8', signal,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([n]) => !n.toUpperCase().startsWith('GIT_'))), GIT_OPTIONAL_LOCKS:'0', GIT_TERMINAL_PROMPT:'0' },
  });
  return { commit: stdout.match(/^# branch\.oid ([a-f0-9]+)$/m)?.[1] ?? null, dirty: stdout.split('\n').some(line => line && !line.startsWith('#')), workspace_fingerprint: hash(stdout) };
}

export async function projectObservation(project, operation, input, signal) {
  const observed_at = new Date().toISOString();
  if (operation === 'files' || operation === 'search-code') {
    const prefix = input.path_prefix ? relativePath(input.path_prefix) : '';
    const listed = await listFiles(project, [prefix], signal);
    const hits = []; let scanned = 0, skipped = 0, limited = listed.truncated;
    for (const path of listed.files) {
      signal?.throwIfAborted();
      if (operation === 'files') { if (!input.query || path.toLowerCase().includes(input.query.toLowerCase())) hits.push({path}); continue; }
      if (scanned >= 8 * 1024 * 1024 || hits.length >= 500) { limited = true; break; }
      let file; try { file = await readProjectFile(project, path); } catch { skipped++; continue; }
      scanned += file.source.size_bytes;
      const lines = file.text.split('\n');
      for (let i=0;i<lines.length;i++) if (lines[i].toLowerCase().includes(input.query.toLowerCase())) {
        hits.push({path, line:i+1, text:lines[i].slice(0,800), line_truncated:lines[i].length>800, sha256:file.source.sha256});
        if(hits.length>=500){limited=true;break;}
      }
    }
    const offset=input.offset??0, limit=input.limit??20;
    return { project_id:project.id, observed_at, operation, entries:hits.slice(offset,offset+limit), total:hits.length, next_offset:offset+limit<hits.length?offset+limit:null, scan_truncated:limited, skipped_files:skipped, warning:'Fresh bounded scan; changing files can shift pages. Use returned hashes before adopting a conclusion.' };
  }
  if (!['capture-evidence','check-evidence'].includes(operation)) throw Error('Unsupported observation.');
  if (operation === 'check-evidence' && input.evidence.project_id !== project.id) throw Error('Evidence belongs to another project.');
  const before=await gitState(project, signal), files=[];
  for(const entry of operation==='capture-evidence'?input.paths.map(path=>({path})):input.evidence.files) {
    signal?.throwIfAborted();
    try { const current=await readProjectFile(project,entry.path); files.push({...current.source, hash_algorithm:'sha256', ...(entry.sha256?{expected_sha256:entry.sha256,changed:current.source.sha256!==entry.sha256}:{})}); }
    catch(error){if(operation==='capture-evidence')throw error;files.push({path:entry.path,changed:true,error:error.message});}
  }
  const after=await gitState(project, signal), changedDuring=before.workspace_fingerprint!==after.workspace_fingerprint||before.commit!==after.commit;
  const changed=operation==='check-evidence'&&(files.some(f=>f.changed)||input.evidence.commit!==after.commit||input.evidence.dirty!==after.dirty||input.evidence.workspace_fingerprint!==after.workspace_fingerprint);
  return {version:1,project_id:project.id,observed_at,...after,files,hash_algorithm:'sha256',changed_during_capture:changedDuring,
    ...(operation==='check-evidence'?{status:changedDuring?'inconclusive':changed?'needs_review':'unchanged'}:{}),
    verification:'unverified',warning:'Read-only observations, not an atomic snapshot or build/hardware validation. Unchanged means these observed inputs match; it does not prove the conclusion.'};
}
