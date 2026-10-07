import { saveMaintenanceStatus } from '../src/lib/maintenance-status.mjs';
import path from 'node:path';
import { createBackup, maintainSources, pruneBackups, verifySnapshot } from '../src/lib/maintenance.mjs';
const [mode, root, destination] = process.argv.slice(2);
try {
  if (!root || !path.isAbsolute(root) || (destination && !path.isAbsolute(destination))) throw Error('Use absolute vault and destination paths');
  let result;
  if (mode === 'scan' && destination) { result = await maintainSources(root, destination); if (result.issues.length || result.source_problems) process.exitCode = 2; }
  else if (mode === 'backup' && destination) { result = await createBackup(root, destination); result.retention = await pruneBackups(destination); }
  else if (mode === 'verify') result = await verifySnapshot(root);
  else throw Error('Usage: maintain-vault.mjs scan|backup VAULT DESTINATION, or verify RESTORED_VAULT');
  if (['scan','backup'].includes(mode)) await saveMaintenanceStatus(root, mode, { success: !process.exitCode, result });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { if(root && path.isAbsolute(root) && ['scan','backup'].includes(mode)) await saveMaintenanceStatus(root,mode,{success:false,error:error.message}).catch(()=>{}); console.error(error.stack); process.exitCode = 1; }
