/** Bound auxiliary evidence as well as text before sending parser output over IPC. */
export function boundExtractionResult(result) {
  if (!result || !Array.isArray(result.units) || result.units.length > 10000) throw new Error('Invalid or oversized extraction result.');
  let textBytes = 0;
  for (const unit of result.units) {
    if (typeof unit.text !== 'string' || !unit.locator || JSON.stringify(unit.locator).length > 2048) throw new Error('Extracted evidence locator is invalid or exceeds 2048 characters.');
    textBytes += Buffer.byteLength(unit.text) + Buffer.byteLength(unit.text_layer ?? '');
    if (textBytes > 4 * 1024 * 1024) throw new Error('Extracted text exceeds the 4 MiB result limit.');
    if (unit.warnings) unit.warnings = unit.warnings.slice(0, 10).map(value => String(value).slice(0, 1000));
  }
  result.warnings = (result.warnings ?? []).slice(0, 20).map(value => String(value).slice(0, 1000));
  if (JSON.stringify(result.metadata ?? {}).length > 16384) {
    // Keep small scalar counts/status, and explicitly report omitted auxiliary structure.
    result.metadata = Object.fromEntries(Object.entries(result.metadata).filter(([key, value]) => key.length < 128 &&
      (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length < 256))).slice(0, 32));
    result.metadata.metadata_truncated = true;
    result.warnings.push('Auxiliary metadata exceeded 16384 characters and was omitted; text units and their locators remain available.');
  }
  return result;
}
