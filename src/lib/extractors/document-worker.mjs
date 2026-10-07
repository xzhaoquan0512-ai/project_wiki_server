import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundExtractionResult } from './result-bounds.mjs';

/** Only fixed document parsers are callable; parser stdout never enters MCP transport. */
export function extractDocument(kind, bytes, options = {}) {
  if (!['html', 'xml', 'docx', 'xlsx', 'pptx', 'xls', 'doc', 'ppt'].includes(kind)) throw new Error('Unknown document parser.');
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['--document-worker'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true,
      execArgv: ['--max-old-space-size=256'],
    });
    let settled = false, diagnostic = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const done = () => error ? reject(error) : resolve(result);
      if (child.exitCode !== null || child.signalCode !== null) done();
      else { child.once('close', done); child.kill(); }
    };
    const timer = setTimeout(() => finish(new Error('Document extraction timed out after 90 seconds.')), 90_000);
    child.once('error', error => finish(error));
    child.once('exit', (code, signal) => { if (!settled) finish(new Error(`Document parser exited (${signal || code})${diagnostic ? `: ${diagnostic.trim()}` : ''}`)); });
    child.once('message', message => message?.ok ? finish(null, message.result) : finish(new Error(message?.error || 'Document parser failed.')));
    child.send({ kind, bytes, options }, error => { if (error) finish(error); });
  });
}

if (process.argv.includes('--document-worker') && process.send) {
  process.once('message', async ({ kind, bytes, options }) => {
    try {
      const result = ['html', 'xml'].includes(kind)
        ? (await import('./markup.mjs')).extractMarkup(bytes, { ...options, kind })
        : await (await import('./office.mjs')).extractOffice(bytes, { ...options, kind });
      process.send({ ok: true, result: boundExtractionResult(result) });
    } catch (error) { process.send({ ok: false, error: String(error.message).slice(0, 4000) }); }
  });
}
