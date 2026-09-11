import { z } from 'zod';
import { AppError } from './errors.js';
import { FileService, hash } from './filesystem.js';
import { fileOperations } from './file-operations.js';
import { downloadChatGptFile } from './file-download.js';
import type { ServiceContext } from './types.js';

// All four properties are required in the descriptor; only the first two are
// required values. This is the ChatGPT MCP fileParams contract, not Actions.
export const chatGptFileSchema = z.object({
  download_url: z.string().min(1).max(16384),
  file_id: z.string().min(1).max(512),
  mime_type: z.string().max(256).optional(),
  file_name: z.string().max(1024).optional(),
}).strict();

export type FileImportInput = {
  workspace_id: string;
  path: string;
  file: z.infer<typeof chatGptFileSchema>;
  expected_sha256: string | null;
  idempotency_key: string;
  /** Optional original-file identity; both fields must be supplied together. */
  expected_source_sha256?: string;
  expected_source_bytes?: number;
};

/** Download a host-provided file and save its exact bytes using normal policy. */
export class FileImportService {
  private active = false;
  constructor(private ctx: ServiceContext, private files: FileService,
    private download: typeof downloadChatGptFile = downloadChatGptFile) {}

  async import(input: FileImportInput) {
    const parsed = chatGptFileSchema.safeParse(input.file);
    if (!parsed.success) throw new AppError('FILE_IMPORT_INVALID_ARGUMENT', 'The host must provide a file object with download_url and file_id. A sandbox path alone is not a downloadable file.');
    if (input.expected_sha256 !== null && !/^[a-f0-9]{64}$/i.test(input.expected_sha256)) throw new AppError('INVALID_ARGUMENT', 'expected_sha256 must be the existing SHA-256 or null for create-only.');
    const checksOriginal = input.expected_source_sha256 !== undefined || input.expected_source_bytes !== undefined;
    if (checksOriginal && (typeof input.expected_source_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.expected_source_sha256)
      || !Number.isSafeInteger(input.expected_source_bytes) || input.expected_source_bytes! < 0 || input.expected_source_bytes! > 134217728)) {
      throw new AppError('FILE_IMPORT_INVALID_ARGUMENT', 'Original-file SHA-256 and byte size must be provided together, with a valid SHA-256 and a size from zero through 134217728.');
    }
    const originalIdentity = checksOriginal ? { expected_source_sha256: input.expected_source_sha256!.toLowerCase(), expected_source_bytes: input.expected_source_bytes! } : {};
    // Take an immutable request snapshot before the first await. The optional
    // filename is metadata only and can never select a local destination.
    const request = { ...input, ...originalIdentity, file: parsed.data };
    await this.ctx.paths.resolve(request.workspace_id, request.path, { write: true, allowMissing: true });
    const legacyPayload = { workspace_id: request.workspace_id, path: request.path, expected_sha256: request.expected_sha256,
      source_sha256: hash(Buffer.from(JSON.stringify(request.file))), ...originalIdentity };
    const payload = { workspace_id: request.workspace_id, path: request.path, expected_sha256: request.expected_sha256?.toLowerCase() ?? null,
      file_identity_sha256: hash(Buffer.from(request.file.file_id)), ...originalIdentity };
    return fileOperations(this.ctx).run({ workspace_id: request.workspace_id, tool: 'fs_import_file', idempotency_key: request.idempotency_key,
      path: request.path, payload, legacyPayload, initialStage: 'downloading', maxAttempts: this.ctx.config.fileImports?.maxAttempts ?? 3,
      retryableErrors: ['FILE_IMPORT_TIMEOUT', 'FILE_IMPORT_DOWNLOAD_FAILED', 'FILE_IMPORT_INTEGRITY_ERROR'],
      beforeStart: () => { if (this.active) throw new AppError('FILE_IMPORT_BUSY', 'Another file import is active. Check its result before starting another import.'); this.active = true; },
      afterFinish: () => { this.active = false; },
    }, async operation => {
        const maxBytes = this.ctx.config.limits.binaryWriteMaxBytes ?? 33554432;
        const bytes = await this.download(request.file.download_url, { maxBytes, timeoutMs: this.ctx.config.fileImports?.downloadTimeoutMs ?? 60_000,
          ...(this.ctx.config.tunnel?.proxyUrl ? { proxyUrl: this.ctx.config.tunnel.proxyUrl } : {}) });
        const sourceHash = hash(bytes);
        operation.content(sourceHash, bytes.length);
        if (checksOriginal && (sourceHash !== request.expected_source_sha256 || bytes.length !== request.expected_source_bytes)) {
          throw new AppError('FILE_IMPORT_ORIGINAL_MISMATCH', 'The downloaded file does not match the original SHA-256 and byte size. The destination was not changed.');
        }
        const saved = await this.files.writeBytes({ workspace_id: request.workspace_id, path: request.path,
          bytes, expected_sha256: request.expected_sha256,
          idempotency_key: 'import:' + hash(Buffer.from(request.idempotency_key)) }, operation);
        return { ...saved, content_processing: 'none' as const, source: 'chatgpt_file_parameter' as const };
    });
  }
}
