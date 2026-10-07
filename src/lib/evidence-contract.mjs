import { z } from 'zod';
export const evidenceSchema = z.object({
  version: z.literal(1), project_id: z.string().min(1).max(160),
  observed_at: z.string().max(80), commit: z.string().max(80).nullable(), dirty: z.boolean(),
  workspace_fingerprint: z.string().regex(/^[a-f0-9]{64}$/), hash_algorithm: z.literal('sha256'),
  changed_during_capture: z.boolean(),
  files: z.array(z.object({ path:z.string().min(1).max(2048), sha256:z.string().regex(/^[a-f0-9]{64}$/), hash_algorithm:z.literal('sha256'), read_at:z.string().max(80), size_bytes:z.number().int().min(0), modified_at:z.string().max(80) }).strict()).min(1).max(50),
  verification: z.literal('unverified'), warning:z.string().max(2000),
}).strict();
