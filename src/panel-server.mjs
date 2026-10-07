import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { serviceRoot } from './vault.mjs';
import { safePath } from './lib/vault-io.mjs';
import { createPanelApi, PanelInputError } from './lib/panel-api.mjs';

const PANEL_ROOT = path.join(serviceRoot, 'templates/panel');
const BODY_LIMIT = 8192;
const BODY_DRAIN_LIMIT = BODY_LIMIT * 64;
const DEFAULT_PORT = 8790;
const DEFAULT_HOST = '127.0.0.1';

// A fixed asset table, not a path-to-file mapping: no request text ever reaches the filesystem.
const ASSETS = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8', html: true }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8', html: true }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8', html: false }],
  ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8', html: false }],
]);

const NOT_FOUND_CODES = new Set(['NOTE_NOT_FOUND', 'HISTORY_NOT_FOUND']);
const CONFLICT_CODES = new Set([
  'VAULT_LOCKED', 'REVISION_CONFLICT', 'TRANSACTION_PENDING', 'TRANSACTION_BLOCKED', 'AMBIGUOUS_NOTE', 'PANEL_CONFLICT',
]);
const BAD_REQUEST_CODES = new Set([
  'INVALID_REQUEST', 'INVALID_IDENTIFIER', 'INVALID_TITLE', 'EMPTY_QUERY', 'INVALID_CATEGORY', 'INVALID_NOTE_PATH',
  'INVALID_FRONTMATTER', 'INVALID_REVIEW', 'REVIEW_REQUIREMENTS', 'NOTE_IDENTITY', 'INVALID_MERGE', 'UNSUPPORTED_NOTE_PATH',
]);

function statusFor(error) {
  if (error instanceof PanelInputError || error.code === 'INVALID_REQUEST') return 400;
  if (NOT_FOUND_CODES.has(error.code) || error.code === 'ENOENT') return 404;
  if (CONFLICT_CODES.has(error.code)) return 409;
  if (BAD_REQUEST_CODES.has(error.code)) return 400;
  return 500;
}

const ROUTES = new Map([
  ['GET /api/describe', ({ api }) => api.describe()],
  ['GET /api/lock', ({ api }) => api.lock()],
  ['GET /api/status', ({ api }) => api.status()],
  ['GET /api/lint', ({ api }) => api.lint()],
  ['GET /api/notes', ({ api, query }) => api.listNotes({
    query: query.get('query'), offset: query.get('offset'), limit: query.get('limit'), include_archived: query.get('include_archived'),
  })],
  ['GET /api/note', ({ api, query }) => api.readNote({ pathOrTitle: query.get('pathOrTitle') })],
  ['GET /api/history', ({ api, query }) => api.history({ pathOrTitle: query.get('pathOrTitle'), revision: query.get('revision') })],
  ['GET /api/index', ({ api, query }) => api.index({ include_archived: query.get('include_archived') })],
  ['GET /api/sources', ({ api, query }) => api.listSources({ offset: query.get('offset'), limit: query.get('limit') })],
  ['GET /api/sources/check', ({ api }) => api.checkSources()],
  ['GET /api/rules', ({ api }) => api.rules()],
  ['GET /api/log', ({ api, query }) => api.activity({ lines: query.get('lines') })],
  ['POST /api/maintenance/rebuild-index', ({ api, body }) => api.rebuildIndex({ confirm: body.confirm })],
  ['POST /api/maintenance/recover-lock', ({ api, body }) => api.recoverLock({ confirm: body.confirm })],
]);

function securityHeaders(html = false) {
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (html) {
    headers['content-security-policy'] = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";
  }
  return headers;
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, { ...securityHeaders(false), 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, type, body) {
  res.writeHead(status, { ...securityHeaders(type.startsWith('text/html')), 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  let overflow = false;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > BODY_DRAIN_LIMIT) { request.destroy(); throw new PanelInputError('Request body is far too large.'); }
    if (total > BODY_LIMIT) overflow = true;
    else chunks.push(chunk);
  }
  if (overflow) throw new PanelInputError(`Request body must stay under ${BODY_LIMIT} bytes.`);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new PanelInputError('Request body must be JSON.'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PanelInputError('Request body must be a JSON object.');
  return parsed;
}

// The panel has no authentication, so a page from another origin must not be able to drive it.
function sameOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
  try { return new URL(origin).host === request.headers.host; }
  catch { return false; }
}

async function handle(request, response, api) {
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
    sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET, HEAD and POST are served.' } });
    return;
  }
  if (!sameOrigin(request)) {
    sendJson(response, 403, { error: { code: 'CROSS_ORIGIN', message: 'Cross-origin requests are refused: this panel has no authentication.' } });
    return;
  }
  let url;
  try { url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`); }
  catch { sendJson(response, 400, { error: { code: 'INVALID_REQUEST', message: 'Malformed request URL.' } }); return; }

  const asset = request.method === 'POST' ? undefined : ASSETS.get(url.pathname);
  if (asset) {
    let body;
    try { body = await readFile(path.join(PANEL_ROOT, asset.file)); }
    catch (error) {
      if (error.code === 'ENOENT') { sendJson(response, 500, { error: { code: 'PANEL_ASSET_MISSING', message: `Panel asset is missing: templates/panel/${asset.file}` } }); return; }
      throw error;
    }
    sendText(response, 200, asset.type, body);
    return;
  }

  const route = ROUTES.get(`${request.method} ${url.pathname}`);
  if (!route) {
    sendJson(response, 404, { error: { code: 'UNKNOWN_ROUTE', message: `No panel route for ${request.method} ${url.pathname}.` } });
    return;
  }
  try {
    const body = request.method === 'POST' ? await readBody(request) : {};
    sendJson(response, 200, { ok: true, data: await route({ api, query: url.searchParams, body }) });
  } catch (error) {
    sendJson(response, statusFor(error), { ok: false, error: { code: error.code ?? 'PANEL_ERROR', message: error.message } });
  }
}

export function isLoopback(host) {
  const value = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

export async function startPanel(vaultPath, { host = DEFAULT_HOST, port = DEFAULT_PORT, allowRemote = false } = {}) {
  if (!isLoopback(host) && !allowRemote) {
    throw new Error(`Refusing to bind the panel to ${host}: it serves vault contents without authentication. Pass --allow-remote only on a trusted network.`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Panel port must be an integer between 0 and 65535.');

  let root;
  try { root = await realpath(vaultPath); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Vault not found: ${vaultPath}. Create one with "init-vault" first.`);
    throw error;
  }
  try {
    if (!(await stat(await safePath(root, 'wiki'))).isDirectory()) throw new Error('not a directory');
  } catch { throw new Error(`Expected a Wiki vault with a wiki/ directory: ${root}`); }

  const api = await createPanelApi(root);
  const server = createServer((request, response) => {
    handle(request, response, api).catch(error => {
      if (!response.headersSent) sendJson(response, 500, { error: { code: 'PANEL_ERROR', message: error.message } });
      else response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    const listening = () => { server.removeListener('error', failed); resolve(); };
    const failed = error => { server.removeListener('listening', listening); reject(error); };
    server.once('error', failed);
    server.once('listening', listening);
    server.listen(port, host);
  });
  server.on('error', error => { console.error(`Knowledge panel server error: ${error.message}`); });
  const address = server.address();
  const displayHost = host.includes(':') ? `[${host}]` : host;
  return {
    server, api, root,
    url: `http://${displayHost}:${address.port}/`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
