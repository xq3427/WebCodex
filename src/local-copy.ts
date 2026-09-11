import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AppError } from './errors.js';
import { FileService, hash } from './filesystem.js';
import { fileOperations } from './file-operations.js';
import { initializeIdentity } from './identity.js';
import type { ServiceContext } from './types.js';

export type LocalCopyInput = {
  workspace_id: string;
  path: string;
  source_workspace_id: string;
  source_path: string;
  expected_source_sha256: string;
  expected_sha256: string | null;
  idempotency_key: string;
};

const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const canonicalPath = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

/** Copy exact local bytes between authorized workspaces, without host file forwarding. */
export class LocalCopyService {
  constructor(private ctx: ServiceContext, private files: FileService) {}

  async copy(input: LocalCopyInput) {
    if (!validHash(input.expected_source_sha256) || input.expected_sha256 !== null && !validHash(input.expected_sha256)) {
      throw new AppError('INVALID_ARGUMENT', 'Provide the source SHA-256 and the current destination SHA-256, or null for a new destination.');
    }
    const request = { ...input, expected_source_sha256: input.expected_source_sha256.toLowerCase(), expected_sha256: input.expected_sha256?.toLowerCase() ?? null };
    const identity = initializeIdentity(this.ctx);
    const sourceBinding = identity.workspaceIdentity(request.source_workspace_id);
    const destinationBinding = identity.workspaceIdentity(request.workspace_id);
    const assertBindings = () => {
      if (identity.workspaceIdentity(request.source_workspace_id) !== sourceBinding || identity.workspaceIdentity(request.workspace_id) !== destinationBinding) {
        throw new AppError('WORKSPACE_IDENTITY_MISMATCH', 'A source or destination workspace changed during the local copy.');
      }
    };
    // A completed operation may still be inspected/replayed after its source was
    // removed. New copies require a complete source snapshot inside the journal.
    const source = await this.ctx.paths.resolve(request.source_workspace_id, request.source_path, { allowMissing: true });
    const destination = await this.ctx.paths.resolve(request.workspace_id, request.path, { write: true, allowMissing: true });
    const resolvedPath = async (absolute: string) => {
      try { return canonicalPath(await fs.realpath(absolute)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return canonicalPath(path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute)));
      }
    };
    if (await resolvedPath(source) === await resolvedPath(destination)) {
      throw new AppError('COPY_SAME_PATH', 'Source and destination refer to the same local file. Choose another destination.');
    }
    const payload = { workspace_id: request.workspace_id, path: request.path, source_workspace_id: request.source_workspace_id,
      source_path: request.source_path, source_workspace_binding: sourceBinding, destination_workspace_binding: destinationBinding,
      expected_source_sha256: request.expected_source_sha256, expected_sha256: request.expected_sha256 };
    assertBindings();
    return fileOperations(this.ctx).run({ workspace_id: request.workspace_id, tool: 'fs_copy', path: request.path,
      idempotency_key: request.idempotency_key, payload }, async operation => {
      const readSource = async () => {
        assertBindings();
        const currentSource = await this.ctx.paths.resolve(request.source_workspace_id, request.source_path);
        await this.ctx.paths.resolve(request.workspace_id, request.path, { write: true, allowMissing: true });
        if (canonicalPath(currentSource) !== canonicalPath(source)) throw new AppError('WORKSPACE_IDENTITY_MISMATCH', 'The source path changed during the local copy.');
        const bytes = await this.files.snapshotForBatch(source, undefined, 'bytes');
        if (bytes === null) throw new AppError('FILE_CHANGED', 'The source file disappeared during the local copy.');
        if (hash(bytes) !== request.expected_source_sha256) {
          throw new AppError('SOURCE_VERSION_CONFLICT', 'The source file differs from expected_source_sha256. Inspect the source again before starting a new copy.');
        }
        assertBindings();
        return bytes;
      };
      const bytes = await readSource();
      operation.content(request.expected_source_sha256, bytes.length);
      const saved = await this.files.writeBytes({ workspace_id: request.workspace_id, path: request.path, bytes,
        expected_sha256: request.expected_sha256, idempotency_key: request.idempotency_key }, operation, {
        additionalLockedPaths: [source],
        beforeCommit: async () => { await readSource(); },
      });
      return { ...saved, source: 'local_workspace' as const, source_workspace_id: request.source_workspace_id,
        source_path: request.source_path, source_sha256: request.expected_source_sha256, content_processing: 'none' as const };
    });
  }
}
