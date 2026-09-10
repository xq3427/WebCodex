import { AppError } from './errors.js';

/** A unified diff may contain both old and new text; output files retain the write limit. */
export const patchInputMaxBytes = (writeMaxBytes: number) => writeMaxBytes * 2;

/** Schema string lengths bound characters; both patch routes also enforce actual UTF-8 bytes. */
export function assertPatchInputSize(patch: unknown, writeMaxBytes: number): asserts patch is string {
  if (typeof patch !== 'string') throw new AppError('FILE_TOO_LARGE', 'A patch exceeds its byte limit or is not text.');
  const size = Buffer.byteLength(patch, 'utf8'), limit = patchInputMaxBytes(writeMaxBytes);
  if (size > limit) throw new AppError('FILE_TOO_LARGE', 'Patch exceeds the UTF-8 request size limit.', { size_bytes: size, limit_bytes: limit });
}
