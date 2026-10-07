import { readdir } from 'node:fs/promises';
import { checkExtractors } from '../../bin/check-extractors.mjs';
import { lockStatus } from './vault-admin.mjs';
import { readJson, safePath } from './vault-io.mjs';
import { FulltextStore } from './fulltext-store.mjs';
import { CompilationStore } from './compilation-store.mjs';

/**
 * One read-only operations view: it answers while another writer holds the vault lock, takes no
 * lock itself, runs no OCR and replays no transaction. Everything it reports is a snapshot of
 * recorded state, not a claim that the recorded work was correct.
 */
export async function opsStatus(root) {
  const lock = await lockStatus(root);

  // Pending transactions are counted, never replayed here: replaying is what a locked write does.
  let pendingTransactions = 0;
  try {
    const entries = await readdir(await safePath(root, '.wiki-server/transactions'));
    for (const file of entries.filter(name => /^[a-f0-9-]+\.json$/.test(name))) {
      const journal = await readJson(root, `.wiki-server/transactions/${file}`, null);
      if (journal?.status !== 'committed') pendingTransactions++;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  // Dependency readiness only: no model download, no OCR, no document conversion.
  const extraction = await checkExtractors();
  const fulltext = await new FulltextStore(root).status();
  const records = Object.values((await new CompilationStore(root).state()).records ?? {});
  const statuses = records.map(record => record?.status);

  return {
    checked_at: new Date().toISOString(),
    vault: {
      locked: lock.locked === true,
      owner: lock.owner ?? null,
      pending_transactions: pendingTransactions,
      note: 'A pending transaction is completed by the next locked operation; this view does not replay it and does not take the write lock.',
    },
    extraction: {
      ready: extraction.ready === true,
      platform: extraction.platform,
      checks: extraction.checks.length,
      unavailable: extraction.checks.filter(check => !check.available).map(check => ({ id: check.id, required: check.required === true, detail: check.detail })),
    },
    fulltext: {
      sources: fulltext.sources.length,
      indexed: fulltext.sources.filter(source => source.indexed).length,
      indexed_pages: fulltext.indexed_pages,
      sparse_pages: fulltext.sources.reduce((total, source) => total + (source.needs_visual_pages?.length ?? 0), 0),
      truncated_pages: fulltext.sources.reduce((total, source) => total + (source.truncated_pages?.length ?? 0), 0),
      semantic_warning: fulltext.semantic_warning,
    },
    compilation: {
      recorded_tasks: statuses.length,
      summarized: statuses.filter(status => status === 'summarized').length,
      needs_review: statuses.filter(status => status === 'needs_review').length,
      note: 'Recorded caller assessments only; wiki_compile_queue re-reads output notes to report staleness.',
    },
    notes: [
      'Read-only snapshot; no OCR, conversion, indexing, download or transaction replay was performed.',
      'Backup and retention live outside the vault: this view cannot report them, see bin/maintain-vault.mjs and the operator schedule.',
    ],
  };
}
