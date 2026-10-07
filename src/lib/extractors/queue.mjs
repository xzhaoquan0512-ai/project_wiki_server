/** Serial parsing with a separate queue deadline so an expired request never starts later. */
export function createExtractionQueue({ max_pending = 8, wait_ms = 60000 } = {}) {
  let tail = Promise.resolve(), pending = 0;
  return async action => {
    if (pending >= max_pending) throw new Error('Extraction queue is full; retry after current reads finish.');
    pending++;
    let expired = false, timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error(`Extraction queue wait exceeded ${wait_ms} ms; request cancelled before parsing. Retry later.`)); }, wait_ms);
    });
    const operation = tail.catch(() => {}).then(() => {
      clearTimeout(timer);
      if (expired) throw new Error('Expired extraction request was skipped.');
      return action();
    });
    tail = operation;
    try { return await Promise.race([operation, deadline]); }
    finally { clearTimeout(timer); pending--; }
  };
}
