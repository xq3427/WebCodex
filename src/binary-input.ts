import { AppError } from './errors.js';
import { FileService, hash } from './filesystem.js';
import { fileOperations } from './file-operations.js';
import { binaryChunkLimits } from './binary-limits.js';
import type { ServiceContext } from './types.js';

export type BinaryInput = {
  workspace_id: string;
  path: string;
  content_base64: string;
  content_sha256: string;
  size_bytes: number;
  expected_sha256: string | null;
  idempotency_key: string;
};
type BinaryByteInput = Omit<BinaryInput, 'content_base64'>;

function validateMetadata(input: BinaryByteInput) {
  if (!Number.isSafeInteger(input.size_bytes) || input.size_bytes < 0 ||
    typeof input.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.content_sha256) ||
    input.expected_sha256 !== null && (typeof input.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.expected_sha256))) {
    throw new AppError('BINARY_INPUT_INVALID', 'Provide a nonnegative integer byte size, a SHA-256 hex digest, and the existing SHA-256 or null for create-only.');
  }
}

export function inlineBinaryWriteLimit(limits: ServiceContext['config']['limits']) {
  return Math.min(limits.inlineBinaryWriteMaxBytes ?? 262_144, limits.binaryWriteMaxBytes ?? 33_554_432);
}

/** Bounded transport for exact file bytes when a host cannot forward file references. */
export class BinaryInputService {
  constructor(private ctx: ServiceContext, private files: FileService) {}

  async write(input: BinaryInput) {
    validateMetadata(input);
    if (typeof input.content_base64 !== 'string') {
      throw new AppError('BINARY_INPUT_INVALID', 'Provide canonical Base64, a nonnegative integer byte size, a SHA-256 hex digest, and the existing SHA-256 or null for create-only.');
    }
    const limit = inlineBinaryWriteLimit(this.ctx.config.limits);
    // Bound the string before allocating decoded bytes. Base64 is transport only,
    // and cannot be used to bypass either the inline or ordinary binary limit.
    if (input.size_bytes > limit || input.content_base64.length > Math.ceil(limit / 3) * 4) {
      throw new AppError('BINARY_INPUT_TOO_LARGE', 'The complete file exceeds the inline binary write limit.', { limit_bytes: limit });
    }
    if (input.content_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content_base64)) {
      throw new AppError('BINARY_INPUT_INVALID', 'Use canonical standard Base64 without a data URL, whitespace, URL-safe alphabet, or incomplete padding.');
    }
    const bytes = Buffer.from(input.content_base64, 'base64');
    if (bytes.toString('base64') !== input.content_base64) throw new AppError('BINARY_INPUT_INVALID', 'The Base64 representation is not canonical.');
    if (bytes.length > limit) throw new AppError('BINARY_INPUT_TOO_LARGE', 'The complete file exceeds the inline binary write limit.', { limit_bytes: limit });
    return this.saveBytes(input, bytes, () => inlineBinaryWriteLimit(this.ctx.config.limits), 'inline_base64');
  }

  /** Internal staging handoff only; no MCP tool accepts this Buffer-based input. */
  async writeVerifiedBytes(input: BinaryByteInput, bytes: Buffer) {
    return this.saveBytes(input, bytes, () => binaryChunkLimits(this.ctx.config).fileMaxBytes, 'chunked_base64');
  }

  private async saveBytes(input: BinaryByteInput, supplied: Buffer, currentLimit: () => number, source: 'inline_base64' | 'chunked_base64') {
    validateMetadata(input);
    if (!Buffer.isBuffer(supplied)) throw new AppError('BINARY_INPUT_INVALID', 'The internal writer requires complete file bytes.');
    const suppliedSize = supplied.length, declaredSize = input.size_bytes;
    const checkLimit = () => {
      const limit = currentLimit();
      if (suppliedSize > limit || declaredSize > limit) throw new AppError('BINARY_INPUT_TOO_LARGE', 'The complete file exceeds its current binary input limit.', { limit_bytes: limit });
    };
    checkLimit();
    // Own the verified bytes before the first await; caller mutation cannot alter
    // the bytes subsequently recorded in the journal or committed to the file.
    const bytes = Buffer.from(supplied);
    const actualHash = hash(bytes);
    if (bytes.length !== input.size_bytes || actualHash !== input.content_sha256.toLowerCase()) {
      throw new AppError('BINARY_INPUT_INTEGRITY_ERROR', 'Decoded file bytes do not match the supplied size and SHA-256. No file was written.');
    }
    // No Base64 or file contents enter durable request metadata or diagnostics.
    const request = { workspace_id: input.workspace_id, path: input.path, expected_sha256: input.expected_sha256?.toLowerCase() ?? null,
      content_sha256: actualHash, size_bytes: bytes.length, idempotency_key: input.idempotency_key };
    await this.ctx.paths.resolve(request.workspace_id, request.path, { write: true, allowMissing: true });
    checkLimit();
    const payload = { workspace_id: request.workspace_id, path: request.path, expected_sha256: request.expected_sha256, content_sha256: actualHash, size_bytes: bytes.length };
    return fileOperations(this.ctx).run({ workspace_id: request.workspace_id, tool: 'fs_write_binary', idempotency_key: request.idempotency_key,
      path: request.path, payload }, async operation => {
      checkLimit();
      operation.content(actualHash, bytes.length);
      const saved = await this.files.writeBytes({ workspace_id: request.workspace_id, path: request.path, bytes,
        expected_sha256: request.expected_sha256, idempotency_key: request.idempotency_key }, operation, { beforeCommit: async () => checkLimit() });
      return { ...saved, content_processing: 'none' as const, source, transport_encoding: 'base64' as const };
    });
  }
}
