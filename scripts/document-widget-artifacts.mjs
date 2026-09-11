import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const WIDGET_BYTE_LIMIT = 5 * 1024 * 1024;
const versionPattern = /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})(?:-preview\.(?:0|[1-9]\d{0,3}))?$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new Error('The document widget artifact cannot be published safely. Existing committed resources are unchanged.');

async function existingBytes(file, limit) {
  let handle;
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > limit) throw invalid();
    handle = await open(file, 'r');
    const before = await handle.stat();
    if (before.ino !== entry.ino || before.size !== entry.size) throw invalid();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw invalid(); offset += result.bytesRead; }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw invalid();
    return bytes;
  } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  finally { await handle?.close(); }
}

async function stage(directory, bytes) {
  const temporary = path.join(directory, `.document-widget-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temporary).catch(() => {}); throw error; }
  await handle.close();
  return temporary;
}

async function atomicRename(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      // Windows scanners/readers can briefly hold a sharing lock. Retain the
      // old complete manifest while retrying; never delete it to make a gap.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 29) throw error;
      await delay(Math.min(5 * (attempt + 1), 50));
    }
  }
}

/** The manifest is the only mutable pointer; old content-addressed and legacy files remain intact. */
export async function publishDocumentWidget(directory, version, input) {
  if (!path.isAbsolute(directory) || !versionPattern.test(version) || !(input instanceof Uint8Array) || !input.byteLength || input.byteLength > WIDGET_BYTE_LIMIT) throw invalid();
  const bytes = Buffer.from(input), sha256 = digest(bytes);
  const file = `document-widget-${version}-${sha256}.js`;
  const manifestName = `document-widget-${version}.json`;
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  const destination = path.join(directory, file);
  const previous = await existingBytes(destination, WIDGET_BYTE_LIMIT);
  if (previous && (previous.length !== bytes.length || digest(previous) !== sha256)) throw invalid();
  if (!previous) {
    const temporary = await stage(directory, bytes);
    try {
      // Concurrent publishers of this name necessarily carry the same SHA-256
      // and bytes; rename never exposes a partially written final artifact.
      await atomicRename(temporary, destination);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  const manifest = { schema_version: 1, version, file, size_bytes: bytes.length, sha256 };
  const manifestPath = path.join(directory, manifestName);
  const oldPointer = await lstat(manifestPath).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error; });
  if (oldPointer && (!oldPointer.isFile() || oldPointer.isSymbolicLink() || oldPointer.nlink !== 1 || oldPointer.size > 4096)) throw invalid();
  const temporary = await stage(directory, Buffer.from(JSON.stringify(manifest) + '\n'));
  try { await atomicRename(temporary, manifestPath); }
  finally { await unlink(temporary).catch(() => {}); }
  return { ...manifest, manifest: manifestName };
}
