const configured = process.env.PROJECT_WIKI_MAX_SOURCE_MIB;
const value = configured === undefined || configured === '' ? 20 : Number(configured);
if (!Number.isInteger(value) || value < 1 || value > 64) {
  throw new Error('PROJECT_WIKI_MAX_SOURCE_MIB must be an integer from 1 to 64 (default 20).');
}
export const MAX_SOURCE_MIB = value;
export const MAX_SOURCE_BYTES = value * 1024 * 1024;
// JSON can escape one input byte as six ASCII bytes (e.g. a control character).
// Bound transport buffering while allowing every valid text/base64 source request.
export const MAX_IMPORT_MESSAGE_BYTES = Math.max(10 * 1024 * 1024, MAX_SOURCE_BYTES * 6 + 1024 * 1024);
