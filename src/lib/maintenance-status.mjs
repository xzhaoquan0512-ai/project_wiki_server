import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, writeJson } from './vault-io.mjs';

export async function saveMaintenanceStatus(root, operation, status) {
  if (!['scan', 'backup'].includes(operation)) throw Error('Unknown maintenance operation.');
  return writeJson(root, `.wiki-server/maintenance/${operation}.json`, { operation, observed_at: new Date().toISOString(), ...status });
}

export async function maintenanceStatus(root) {
  const result = {};
  for (const operation of ['scan', 'backup']) {
    const receipt = await readJson(root, `.wiki-server/maintenance/${operation}.json`, null);
    let systemd = { available: false, reason: 'systemd is not available on this platform' };
    if (process.platform === 'linux') {
      try {
        const { stdout } = await promisify(execFile)('systemctl', ['show', `project-wiki-${operation}.service`, `project-wiki-${operation}.timer`, '--property=Id,LoadState,ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,NextElapseUSecRealtime'], { timeout: 3000, maxBuffer: 16000, encoding: 'utf8', shell: false });
        systemd = { available: true, units: stdout.trim().split(/\n\n/).map(block => Object.fromEntries(block.split('\n').filter(Boolean).map(line => { const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)]; }))) };
      } catch (error) { systemd = { available: false, reason: `systemctl unavailable (${error.code ?? error.name})` }; }
    }
    result[operation] = { receipt, systemd, warning: 'Receipt and timer are separate observations. A later failed service result overrides an older successful receipt; missing receipt does not mean success.' };
  }
  return result;
}
