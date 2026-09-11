import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { AppError } from './errors.js';
import { initializeIdentity } from './identity.js';
import type { ServiceContext } from './types.js';
import { FILE_ROUTES } from './file-routing.js';

const DEFAULT_LIMIT = 4 * 1024 * 1024;
const MAX_LIMIT = 7 * 1024 * 1024;
export const DEFAULT_WIDGET_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_WIDGET_UPLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_WIDGET_CACHE_BYTES = 32 * 1024 * 1024;

/** Static limits, not a promise of free cache space or acceptance by the browser host. */
export function originalFileLimits(limits: ServiceContext['config']['limits']) {
  const inline = limits.fileTransferMaxBytes ?? DEFAULT_LIMIT;
  const upload = limits.fileWidgetUploadMaxBytes ?? DEFAULT_WIDGET_UPLOAD_BYTES;
  const cache = limits.fileWidgetCacheMaxBytes ?? DEFAULT_WIDGET_CACHE_BYTES;
  if (!Number.isSafeInteger(inline) || inline < 1 || inline > MAX_LIMIT ||
      !Number.isSafeInteger(upload) || upload < 1 || upload > MAX_WIDGET_UPLOAD_BYTES ||
      !Number.isSafeInteger(cache) || cache < 1 || cache > 256 * 1024 * 1024) {
    throw new AppError('CONFIG_ERROR', 'Invalid original-file, component upload or snapshot cache byte limit.');
  }
  return {
    inline_max_bytes: inline,
    max_upload_bytes: upload,
    max_upload_bytes_scope: 'component_upload_policy' as const,
    snapshot_cache_max_bytes: cache,
    effective_local_file_max_bytes: Math.min(inline, upload, cache),
    effective_local_file_limit_scope: 'per_file_with_empty_cache' as const,
  };
}
const changed = () => new AppError('FILE_CHANGED', 'The selected file changed during transfer. Read the current complete file again.');
const same = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs &&
  (a.dev === b.dev || process.platform === 'win32' && (a.dev === 0n || b.dev === 0n));

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword', '.dot': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  '.docm': 'application/vnd.ms-word.document.macroEnabled.12', '.dotm': 'application/vnd.ms-word.template.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel', '.xlt': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xltx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12', '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  '.xltm': 'application/vnd.ms-excel.template.macroEnabled.12',
  '.ppt': 'application/vnd.ms-powerpoint', '.pps': 'application/vnd.ms-powerpoint', '.pot': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  '.potx': 'application/vnd.openxmlformats-officedocument.presentationml.template',
  '.pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  '.ppsm': 'application/vnd.ms-powerpoint.slideshow.macroEnabled.12', '.potm': 'application/vnd.ms-powerpoint.template.macroEnabled.12',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation', '.odg': 'application/vnd.oasis.opendocument.graphics',
  '.rtf': 'application/rtf', '.epub': 'application/epub+zip',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.gzip': 'application/gzip', '.tgz': 'application/gzip',
  '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
  '.bz2': 'application/x-bzip2', '.xz': 'application/x-xz',
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json',
  '.jsonl': 'application/x-ndjson', '.ndjson': 'application/x-ndjson', '.xml': 'application/xml',
  '.yaml': 'application/yaml', '.yml': 'application/yaml', '.toml': 'application/toml',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.ico': 'image/vnd.microsoft.icon', '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
export const originalFileMime = (name:string) => MIME_BY_EXTENSION[path.extname(name).toLowerCase()] ?? 'application/octet-stream';

/** Identify only well-known image headers; this does not decode or validate an image. */
function imageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.subarray(12, 16).equals(Buffer.from('IHDR')) && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    (bytes[3] >= 0xe0 && bytes[3] <= 0xef || bytes[3] === 0xdb || bytes[3] >= 0xc0 && bytes[3] <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(bytes[3]))) return 'image/jpeg';
  if (bytes.length >= 13 && (bytes.subarray(0, 6).equals(Buffer.from('GIF87a')) || bytes.subarray(0, 6).equals(Buffer.from('GIF89a'))) &&
    bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0) return 'image/gif';
  if (bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP')) &&
    bytes.readUInt32LE(4) + 8 === bytes.length && ['VP8 ', 'VP8L', 'VP8X'].some(chunk => bytes.subarray(12, 16).equals(Buffer.from(chunk))) &&
    bytes.readUInt32LE(16) > 0 && bytes.readUInt32LE(16) <= bytes.length - 20) return 'image/webp';
  return undefined;
}

/** Full original bytes in one MCP content block; no text extraction or format conversion. */
export class FileTransferService {
  private readonly instanceId = randomUUID();
  constructor(private readonly ctx: ServiceContext) {}

  async read(input: { workspace_id: string; path: string }) {
    const limit = this.ctx.config.limits.fileTransferMaxBytes ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new AppError('CONFIG_ERROR', 'limits.fileTransferMaxBytes must be a positive integer of at most 7 MiB.');
    const absolute = await this.ctx.paths.resolve(input.workspace_id, input.path);
    const identity = initializeIdentity(this.ctx);
    const binding = identity.workspaceIdentity(input.workspace_id);
    const relative = path.relative(this.ctx.paths.get(input.workspace_id).root, absolute).split(path.sep).join('/');
    const before = await fs.lstat(absolute, { bigint: true });
    if (!before.isFile()) throw new AppError('NOT_A_FILE', 'Whole-file transfer requires a regular file.');
    if (before.isSymbolicLink() || before.nlink !== 1n) throw new AppError('PATH_DENIED', 'Whole-file transfer does not support linked files.');
    if (before.size > BigInt(limit)) throw new AppError('FILE_TOO_LARGE', 'The complete file exceeds limits.fileTransferMaxBytes; no partial file was transferred. A larger component upload setting does not raise this local inline limit.', { size_bytes: Number(before.size), limit, effective_local_file_max_bytes: limit, effective_local_file_limit_scope: 'inline_transfer' });

    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const initial = await handle.stat({ bigint: true });
      if (!initial.isFile() || initial.nlink !== 1n || !same(before, initial)) throw changed();
      const bytes = Buffer.alloc(Number(initial.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
        if (!bytesRead) throw changed();
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (!after.isFile() || after.nlink !== 1n || !same(initial, after)) throw changed();
      await this.ctx.paths.resolve(input.workspace_id, input.path);
      const current = await fs.lstat(absolute, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !same(initial, current)) throw changed();
      if (identity.workspaceIdentity(input.workspace_id) !== binding) throw changed();

      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const name = path.basename(absolute);
      const signature = imageMime(bytes);
      const extension = MIME_BY_EXTENSION[path.extname(name).toLowerCase()];
      const mimeType = signature ?? extension ?? 'application/octet-stream';
      const contentKind = signature ? 'image' as const : 'resource' as const;
      const uri = `webcodex-file://${this.instanceId}/${binding}/${sha256}/${encodeURIComponent(name)}`;
      const encoded = bytes.toString('base64');
      const content: ContentBlock[] = signature
        ? [{ type: 'image', data: encoded, mimeType }]
        : [{ type: 'resource', resource: { uri, mimeType, blob: encoded } }];
      const data = {
        workspace_id: input.workspace_id, path: relative, name, display_name: name, size_bytes: bytes.length, sha256,
        mime_type: mimeType, mime_type_source: signature ? 'signature' as const : extension ? 'extension' as const : 'default' as const,
        content_validated: false, content_processing: 'none' as const, client_attachment_support: 'unverified' as const,
        content_processing_scope: 'server_only' as const, model_access: 'unverified' as const,
        content_kind: contentKind, transfer_encoding: 'base64' as const, complete: true as const,
        effective_local_file_max_bytes: limit, effective_local_file_limit_scope: 'inline_transfer' as const,
        snapshot_uri: uri, uri_scope: 'embedded_snapshot_only' as const,
        model_usage: 'Use display_name/name as the human-readable file label. snapshot_uri identifies the already embedded snapshot; it is not a download link or a resources/read endpoint. MIME is a format hint, not proof of validity or host capabilities. content_processing:none means only that this server preserved the original bytes without conversion; it does not mean the host cannot parse or preview the file. Use the original native content if the host exposes it. If only metadata or a file card is accessible, do not claim to have read the file contents. Do not automatically substitute text extraction, OCR, rendering, media conversion or archive extraction for an original-file request.',
        ...(!signature ? { next_step: {
          when: mimeType === 'application/pdf' ? 'For a PDF text-analysis request, follow this reading route. '+FILE_ROUTES.pdf : FILE_ROUTES.diagnostic+' This format has no built-in document text reader. A transfer receipt does not prove actual file access.',
          tool: mimeType === 'application/pdf' ? 'document_open' as const : 'fs_open_file' as const,
          arguments: { workspace_id: input.workspace_id, path: relative, expected_device_id: identity.deviceId },
        } } : {}),
      };
      this.ctx.store.audit('fs_read_file', input.workspace_id, { path: relative, size_bytes: bytes.length, sha256, mime_type: mimeType, content_kind: contentKind });
      return { data, content };
    } finally { await handle.close(); }
  }
}
