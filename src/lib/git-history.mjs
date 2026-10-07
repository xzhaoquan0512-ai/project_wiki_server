import { relativePath } from './project-paths.mjs';

// Fixed templates for read-only Git history. The caller chooses a mode, at most one revision and
// at most one in-project path; it can never add a flag, a range or a second command.
const MODES = new Set(['diff', 'log', 'show']);
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9_./~^-]{0,119}$/;

/** The argv a context_session backend should run; that backend adds its own safety switches. */
export function gitHistoryArgv({ mode, ref, path: target, entries } = {}) {
  if (!MODES.has(mode)) throw new Error('mode must be diff, log or show.');
  if (entries !== undefined && (mode !== 'log' || !Number.isInteger(entries) || entries < 1 || entries > 200)) {
    throw new Error('entries applies to log only and must be an integer from 1 to 200.');
  }
  if (ref !== undefined && (typeof ref !== 'string' || !SAFE_REF.test(ref) || ref.includes('..'))) {
    throw new Error('ref must be one revision such as HEAD, HEAD~1 or main; ranges and flags are not accepted.');
  }
  const argv = ['git', mode];
  if (mode === 'log') argv.push('-n', String(entries ?? 20));
  if (ref !== undefined) argv.push(ref);
  if (target !== undefined) argv.push('--', relativePath(target));
  return argv;
}

// A repository can configure an external diff driver or a textconv filter, which would execute a
// program on our behalf. These switches and the sanitized environment keep a direct call to the
// three read-only subcommands; the context_session backend injects its own equivalents.
export const GIT_SAFETY_ARGV = ['--no-pager', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false'];
export const GIT_READ_FLAGS = ['--no-ext-diff', '--no-textconv'];

/** The complete argv for running Git directly, with the safety switches already in place. */
export function gitHistoryCommand(input) {
  const [, mode, ...tail] = gitHistoryArgv(input);
  return [...GIT_SAFETY_ARGV, mode, ...GIT_READ_FLAGS, ...tail];
}
