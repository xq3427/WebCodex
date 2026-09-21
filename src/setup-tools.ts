import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { AppError } from './errors.js';
import { setupReleaseCatalog } from './setup-catalog.js';

type Platform = 'win32' | 'linux' | 'darwin';
type Architecture = 'x64' | 'arm64';
type Tool = 'git' | 'rg' | 'tunnel';
type ReleaseAsset = { name: string; size: number; digest?: string; browser_download_url: string; url?: string };
type Release = { tag_name: string; html_url: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] };
type Member = { name: string; data?: Buffer; executable: boolean };
export type SetupToolRecord = {
  tool: 'node' | Tool; executable: string; version: string;
  source: 'current_runtime' | 'system' | 'official_release';
  verification: string; executableSha256?: string; archiveSha256?: string;
};
export interface SetupToolsOptions {
  toolsDir: string;
  gitPath?: string;
  rgPath?: string;
  proxyUrl?: string;
  onProgress?: (message: string) => void;
}
/** In-process test seams only. CLI flags cannot supply downloaders or bypass verification. */
export interface SetupToolsDependencies {
  platform?: Platform;
  arch?: Architecture;
  env?: NodeJS.ProcessEnv;
  download?: (url: string, options: { maxBytes: number; proxyUrl?: string }) => Promise<Buffer>;
  probe?: (executable: string) => Promise<string | undefined>;
}
export interface SetupToolsResult {
  nodePath: string; gitPath: string; rgPath: string; tunnelPath: string;
  installed: SetupToolRecord[];
}
const ARCHIVE_LIMIT = 128 * 1024 * 1024;
const EXTRACT_LIMIT = 512 * 1024 * 1024;
const FILE_LIMIT = 256 * 1024 * 1024;
const META_LIMIT = 4 * 1024 * 1024;
const MAX_MEMBERS = 20_000;
const repositories = { git: 'git-for-windows/git', rg: 'BurntSushi/ripgrep', tunnel: 'openai/tunnel-client' } as const;
const directories = { git: 'git', rg: 'ripgrep', tunnel: 'tunnel-client' } as const;
const error = (code: string, message: string) => new AppError(code, message);
const invalidArchive = () => error('SETUP_ARCHIVE_INVALID', 'The official archive contains unsupported, unsafe or inconsistent entries; no tool was installed.');
const conflict = () => error('SETUP_INSTALL_CONFLICT', 'The tool destination contains an unknown or modified installation. Preserve it and choose an empty toolsDir or restore its verified installation; setup does not overwrite it.');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const within = (root: string, file: string) => { const rel = path.relative(root, file); return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep); };
const recordedPath = (root: string, value: unknown) => {
  if (typeof value !== 'string' || !value || [...value].some(character => { const code = character.charCodeAt(0); return code < 0x20 || code === 0x7f; })) throw conflict();
  const resolved = path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value.split('/').join(path.sep));
  if (!within(root, resolved)) throw conflict();
  return resolved;
};

function officialUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw error('SETUP_SOURCE_DENIED', 'Dependency downloads require official HTTPS release sources.'); }
  const hosts = ['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || url.hash || url.port && url.port !== '443' || /[\x00-\x20\x7f]/.test(input)) {
    throw error('SETUP_SOURCE_DENIED', 'Dependency downloads require official HTTPS release sources.');
  }
  return url;
}
function proxyAddress(input?: string): URL | undefined {
  if (!input) return undefined;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || /[\x00-\x20\x7f]/.test(input)) throw new Error();
    return url;
  } catch { throw error('SETUP_PROXY_INVALID', 'The setup proxy must be an HTTP(S) origin without credentials, path, query or fragment.'); }
}
async function proxyConnection(proxy: URL, hostname: string, signal: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const request = (proxy.protocol === 'https:' ? https : http).request(proxy, {
      method: 'CONNECT', path: hostname + ':443', headers: { Host: hostname + ':443' }, signal, agent: false,
    });
    request.once('error', reject);
    request.once('response', response => { response.destroy(); reject(error('SETUP_DOWNLOAD_FAILED', 'The configured proxy did not establish a secure connection.')); });
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200 || head.length) { socket.destroy(); reject(error('SETUP_DOWNLOAD_FAILED', 'The configured proxy did not establish a secure connection.')); return; }
      const secured = tls.connect({ socket, servername: hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
      const abort = () => secured.destroy(new Error('Setup download deadline exceeded.'));
      signal.addEventListener('abort', abort, { once: true });
      secured.once('close', () => signal.removeEventListener('abort', abort));
      secured.once('error', reject);
      secured.once('secureConnect', () => { if (signal.aborted) abort(); else resolve(secured); });
    });
    request.end();
  });
}
async function downloadOfficial(input: string, options: { maxBytes: number; proxyUrl?: string }): Promise<Buffer> {
  const proxy = proxyAddress(options.proxyUrl), controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 180_000);
  try {
    let url = officialUrl(input);
    for (let redirects = 0; redirects <= 5; redirects++) {
      let agent: https.Agent | undefined;
      if (proxy) {
        const socket = await proxyConnection(proxy, url.hostname, controller.signal);
        agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
        agent.createConnection = () => socket;
      }
      try {
        const result = await new Promise<Buffer | URL>((resolve, reject) => {
          const request = https.request(url, { signal: controller.signal, agent: agent ?? false, headers: {
            'User-Agent': 'WebCodex-local-setup', Accept: url.hostname === 'api.github.com' && !/\/releases\/assets\/\d+$/.test(url.pathname) ? 'application/vnd.github+json' : 'application/octet-stream', 'Accept-Encoding': 'identity',
          } }, response => {
            response.once('error', reject);
            if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
              try {
                if (!response.headers.location) throw new Error();
                resolve(officialUrl(new URL(response.headers.location, url).href));
              } catch { reject(error('SETUP_SOURCE_DENIED', 'The dependency download redirected outside official HTTPS release hosting.')); }
              response.destroy(); return;
            }
            if (response.statusCode !== 200) {
              reject(error('SETUP_DOWNLOAD_FAILED', response.statusCode === 403 || response.statusCode === 429
                ? 'GitHub public downloads are rate limited or unavailable. Retry later or configure the setup HTTPS proxy; no API credential is required.'
                : `Official dependency download failed (HTTP ${response.statusCode ?? 'unknown'}). Check network access or the configured setup proxy.`));
              response.destroy(); return;
            }
            const declared = response.headers['content-length'];
            if (declared && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > options.maxBytes) || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
              reject(error('SETUP_DOWNLOAD_INVALID', 'The dependency response exceeds its size limit or uses an unexpected encoding.')); response.destroy(); return;
            }
            const chunks: Buffer[] = []; let length = 0;
            response.on('data', (chunk: Buffer) => {
              length += chunk.length;
              if (length > options.maxBytes) { reject(error('SETUP_DOWNLOAD_INVALID', 'The dependency response exceeds its size limit.')); response.destroy(); }
              else chunks.push(chunk);
            });
            response.once('end', () => {
              if (declared && Number(declared) !== length) reject(error('SETUP_DOWNLOAD_INVALID', 'The dependency download is incomplete.'));
              else resolve(Buffer.concat(chunks));
            });
          });
          request.once('error', reject); request.end();
        });
        if (Buffer.isBuffer(result)) return result;
        url = result;
      } finally { agent?.destroy(); }
    }
    throw error('SETUP_DOWNLOAD_FAILED', 'The official dependency download exceeded its redirect limit.');
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw error('SETUP_DOWNLOAD_FAILED', 'The official dependency download could not finish within 180 seconds. Check network access or supply the setup proxy option.');
  } finally { clearTimeout(deadline); }
}

function safeMember(input: string, directory: boolean): string {
  const name = directory ? input.replace(/\/$/, '') : input;
  if (!name || name.length > 1024 || name.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(name)) throw invalidArchive();
  if (name.split('/').some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw invalidArchive();
  return name;
}
function checkedMembers(members: Member[]): Member[] {
  if (!members.length || members.length > MAX_MEMBERS) throw invalidArchive();
  const seen = new Map<string, boolean>(); let total = 0;
  for (const member of members) {
    const normalized = member.name.toLowerCase();
    if (seen.has(normalized)) throw invalidArchive();
    seen.set(normalized, member.data !== undefined);
    total += member.data?.length ?? 0;
    if (total > EXTRACT_LIMIT) throw invalidArchive();
  }
  for (const member of members) {
    const parts = member.name.toLowerCase().split('/'); parts.pop();
    while (parts.length) { if (seen.get(parts.join('/')) === true) throw invalidArchive(); parts.pop(); }
  }
  return members;
}
function unzip(bytes: Buffer): Member[] {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw invalidArchive();
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count !== bytes.readUInt16LE(end + 8) || count === 65535 || count > MAX_MEMBERS || start + size !== end) throw invalidArchive();
  const members: Member[] = [], ranges: [number, number][] = []; let offset = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalidArchive();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const external = bytes.readUInt32LE(offset + 38), local = bytes.readUInt32LE(offset + 42);
    const mode = external >>> 16, kind = mode & 0xf000;
    if (flags & 1 || ![0, 8].includes(method) || ![0, 0x8000, 0x4000].includes(kind) || external & 0x400 || bytes.readUInt16LE(offset + 34) || expanded > FILE_LIMIT || offset + 46 + nameLength + extra + comment > end) throw invalidArchive();
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength), input = rawName.toString('utf8');
    if (input.includes('\ufffd')) throw invalidArchive();
    const directory = input.endsWith('/');
    if (kind === 0x4000 && !directory || kind === 0x8000 && directory || directory && expanded !== 0) throw invalidArchive();
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw invalidArchive();
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), content = local + 30 + localName + localExtra;
    if (!rawName.equals(bytes.subarray(local + 30, local + 30 + localName)) || content > start || compressed > start - content) throw invalidArchive();
    total += expanded; if (total > EXTRACT_LIMIT) throw invalidArchive();
    ranges.push([local, content + compressed]);
    const payload = bytes.subarray(content, content + compressed);
    const data = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: Math.max(1, expanded) });
    if (data.length !== expanded) throw invalidArchive();
    members.push({ name: safeMember(input, directory), ...(!directory ? { data } : {}), executable: (mode & 0o111) !== 0 });
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end) throw invalidArchive();
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) throw invalidArchive();
  return checkedMembers(members);
}
function untar(bytes: Buffer): Member[] {
  const expanded = gunzipSync(bytes, { maxOutputLength: EXTRACT_LIMIT });
  const members: Member[] = []; let offset = 0, ended = false;
  const string = (start: number, length: number) => expanded.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  const octal = (start: number, length: number) => {
    const text = string(start, length).trim();
    if (!/^[0-7]+$/.test(text)) throw invalidArchive();
    const value = Number.parseInt(text, 8); if (!Number.isSafeInteger(value)) throw invalidArchive(); return value;
  };
  while (offset + 512 <= expanded.length) {
    const header = expanded.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) { ended = true; if (expanded.subarray(offset).some(byte => byte !== 0)) throw invalidArchive(); break; }
    if (members.length >= MAX_MEMBERS) throw invalidArchive();
    let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== octal(offset + 148, 8)) throw invalidArchive();
    const kind = expanded[offset + 156], length = octal(offset + 124, 12), mode = octal(offset + 100, 8);
    if (![0, 48, 53].includes(kind) || length > FILE_LIMIT || offset + 512 + length > expanded.length || string(offset + 157, 100)) throw invalidArchive();
    const prefix = string(offset + 345, 155), name = string(offset, 100), directory = kind === 53;
    if (directory && length !== 0) throw invalidArchive();
    members.push({ name: safeMember(prefix ? prefix + '/' + name : name, directory), ...(!directory ? { data: expanded.subarray(offset + 512, offset + 512 + length) } : {}), executable: (mode & 0o111) !== 0 });
    offset += 512 + Math.ceil(length / 512) * 512;
  }
  if (!ended) throw invalidArchive();
  return checkedMembers(members);
}
function extractMembers(archive: Buffer, filename: string): Member[] {
  try { return filename.endsWith('.zip') ? unzip(archive) : filename.endsWith('.tar.gz') ? untar(archive) : (() => { throw invalidArchive(); })(); }
  catch { throw invalidArchive(); }
}

async function plainDirectory(input: string, create: boolean): Promise<string> {
  if (!path.isAbsolute(input) || /[\x00-\x1f\x7f]/.test(input)) throw error('SETUP_PATH_INVALID', 'toolsDir must be an absolute local directory without symbolic links.');
  const full = path.resolve(input); let current = path.parse(full).root;
  for (const part of full.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (cause) {
      if (!create || (cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      try { await mkdir(current, { mode: 0o700 }); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw error('SETUP_PATH_INVALID', 'toolsDir must be an absolute local directory without symbolic links.');
  }
  return full;
}
async function plainBytes(file: string, max: number): Promise<Buffer> {
  await plainDirectory(path.dirname(file), false);
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(max)) throw conflict();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.ino !== before.ino || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) throw conflict();
    const data = await handle.readFile(), after = await lstat(file, { bigint: true });
    if (!after.isFile() || after.nlink !== 1n || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs) throw conflict();
    return data;
  } finally { await handle.close(); }
}
async function probeExecutable(executable: string): Promise<string | undefined> {
  return new Promise(resolve => {
    let output = '', settled = false;
    const child = spawn(executable, ['--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); finish(undefined); }, 15_000);
    function finish(value: string | undefined) { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } }
    child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString('utf8'); if (output.length > 65536) { child.kill(); finish(undefined); } });
    child.stderr.on('data', () => { /* version diagnostics are not exposed */ });
    child.once('error', () => finish(undefined));
    child.once('close', code => finish(code === 0 ? output.trim().split(/\r?\n/, 1)[0] : undefined));
  });
}
async function discover(tool: 'git' | 'rg', selected: string | undefined, platform: Platform, env: NodeJS.ProcessEnv, probe: NonNullable<SetupToolsDependencies['probe']>): Promise<SetupToolRecord | undefined> {
  const explicit = selected !== undefined && selected !== 'auto';
  const search = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const candidates = explicit ? [selected] : search.split(path.delimiter).filter(Boolean).filter(path.isAbsolute).map(directory => path.join(directory, tool + (platform === 'win32' ? '.exe' : '')));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || /\.(?:cmd|bat|ps1)$/i.test(candidate)) continue;
    const version = await probe(candidate);
    if (version && (tool === 'git' ? /^git version / : /^ripgrep /).test(version)) return { tool, executable: candidate, version, source: 'system', verification: 'Existing local executable detected by --version; no download provenance claim.' };
  }
  if (explicit) throw error('SETUP_CONFIGURED_TOOL_INVALID', `The configured ${tool} executable is unavailable. Correct its explicit path or select auto; setup does not silently replace a custom executable.`);
  return undefined;
}
function releaseAsset(release: Release, name: string, repository: string): ReleaseAsset {
  const matches = release.assets.filter(item => item.name === name);
  if (matches.length !== 1) throw error('SETUP_RELEASE_UNSUPPORTED', 'The official release does not provide exactly one verified archive for this operating system and architecture.');
  const asset = matches[0];
  if (asset.browser_download_url !== `https://github.com/${repository}/releases/download/${release.tag_name}/${name}` || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > ARCHIVE_LIMIT) throw error('SETUP_SOURCE_DENIED', 'The release asset URL or size does not match the expected official source.');
  if (asset.url !== undefined && !new RegExp('^https://api\\.github\\.com/repos/' + repository + '/releases/assets/[0-9]+$').test(asset.url)) throw error('SETUP_SOURCE_DENIED', 'The release asset API URL does not match its official repository.');
  return asset;
}
function archiveName(tool: Tool, version: string, platform: Platform, arch: Architecture): string {
  if (tool === 'tunnel') return `tunnel-client-${version}-${platform === 'win32' ? 'windows' : platform}-${arch === 'x64' ? 'amd64' : 'arm64'}.zip`;
  if (tool === 'git') {
    const match = /^v(\d+\.\d+\.\d+)\.windows\.(\d+)$/.exec(version);
    if (!match || platform !== 'win32') throw error('SETUP_RELEASE_UNSUPPORTED', 'The official portable Git release is only supported on Windows.');
    return `MinGit-${match[1]}${match[2] === '1' ? '' : '.' + match[2]}-${arch === 'x64' ? '64-bit' : 'arm64'}.zip`;
  }
  const machine = arch === 'x64' ? 'x86_64' : 'aarch64';
  return `ripgrep-${version}-${machine}-${platform === 'win32' ? 'pc-windows-msvc.zip' : platform === 'darwin' ? 'apple-darwin.tar.gz' : 'unknown-linux-musl.tar.gz'}`;
}

type Installation = {
  version: string; architecture?: string; platform?: string; releaseUrl: string; checkedAt: string;
  executable: string; executableSha256: string; archive: string; archiveSha256: string; verification: string;
  files?: { path: string; sha256: string }[];
};
async function existingInstall(root: string, tool: Tool, platform: Platform, arch: Architecture): Promise<SetupToolRecord | undefined> {
  try { await lstat(root); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause; }
  try {
    await plainDirectory(root, false);
    const record = JSON.parse((await plainBytes(path.join(root, 'install.json'), META_LIMIT)).toString('utf8').replace(/^\uFEFF/, '')) as Installation;
    const versionPattern = tool === 'tunnel' ? /^v\d+\.\d+\.\d+$/ : tool === 'git' ? /^v\d+\.\d+\.\d+\.windows\.\d+$/ : /^\d+\.\d+\.\d+$/;
    if (!versionPattern.test(record.version) || record.releaseUrl !== `https://github.com/${repositories[tool]}/releases/tag/${record.version}` || record.platform !== undefined && record.platform !== platform && !(platform === 'win32' && record.platform === 'windows') || record.architecture !== undefined && record.architecture !== arch && record.architecture !== (arch === 'x64' ? 'amd64' : 'arm64')) throw conflict();
    const executable = recordedPath(root, record.executable), archive = recordedPath(root, record.archive);
    if (!/^[a-f0-9]{64}$/.test(record.executableSha256) || !/^[a-f0-9]{64}$/.test(record.archiveSha256)) throw conflict();
    if (sha(await plainBytes(executable, FILE_LIMIT)) !== record.executableSha256 || sha(await plainBytes(archive, ARCHIVE_LIMIT)) !== record.archiveSha256) throw conflict();
    if (record.files) {
      if (!Array.isArray(record.files) || record.files.length > MAX_MEMBERS) throw conflict();
      for (const entry of record.files) {
        const file = path.join(root, safeMember(entry.path, false));
        if (!within(root, file) || !/^[a-f0-9]{64}$/.test(entry.sha256) || sha(await plainBytes(file, FILE_LIMIT)) !== entry.sha256) throw conflict();
      }
    } else if (tool !== 'tunnel') throw conflict();
    return { tool, executable, version: record.version, source: 'official_release', verification: record.verification, executableSha256: record.executableSha256, archiveSha256: record.archiveSha256 };
  } catch { throw conflict(); }
}

async function install(tool: Tool, toolsDir: string, platform: Platform, arch: Architecture, options: SetupToolsOptions, deps: SetupToolsDependencies): Promise<SetupToolRecord> {
  const root = path.join(toolsDir, directories[tool]);
  const existing = await existingInstall(root, tool, platform, arch);
  if (existing) { options.onProgress?.(`${tool}: using the verified local installation.`); return existing; }
  const download = deps.download ?? downloadOfficial;
  const get = async (url: string, maxBytes: number) => {
    officialUrl(url);
    const bytes = await download(url, { maxBytes, proxyUrl: options.proxyUrl });
    if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) throw error('SETUP_DOWNLOAD_INVALID', 'Dependency response exceeds its size limit.');
    return bytes;
  };
  const getAsset = async (asset: ReleaseAsset, maxBytes: number) => {
    if (!asset.url) return get(asset.browser_download_url, maxBytes);
    try { return await get(asset.url, maxBytes); }
    catch (cause) {
      // Both routes name this exact public release asset. A transient API
      // failure/rate limit may use its public download URL, never new mirrors.
      // Source-policy or byte-integrity failures do not enter this fallback.
      if (!(cause instanceof AppError) || cause.code !== 'SETUP_DOWNLOAD_FAILED') throw cause;
      options.onProgress?.(`${tool}: the public asset API is unavailable; trying the same verified release download URL.`);
      return get(asset.browser_download_url, maxBytes);
    }
  };
  options.onProgress?.(`${tool}: checking the official release.`);
  let release: Release;
  try { release = JSON.parse((await get(`https://api.github.com/repos/${repositories[tool]}/releases/latest`, META_LIMIT)).toString('utf8')); }
  catch (cause) {
    if (cause instanceof AppError && cause.code === 'SETUP_DOWNLOAD_FAILED') {
      // A release ships the exact public metadata of reviewed stable versions.
      // Only metadata unavailability uses this pinned fallback; malformed data
      // and source-policy failures are never replaced by a guessed release.
      release = structuredClone(setupReleaseCatalog[tool]);
      options.onProgress?.(`${tool}: the public release API is unavailable; using the bundled verified release ${release.tag_name}.`);
    } else if (cause instanceof AppError) throw cause;
    else throw error('SETUP_RELEASE_INVALID', 'The official release metadata is malformed.');
  }
  const versionPattern = tool === 'tunnel' ? /^v\d+\.\d+\.\d+$/ : tool === 'git' ? /^v\d+\.\d+\.\d+\.windows\.\d+$/ : /^\d+\.\d+\.\d+$/;
  if (!release || release.draft !== false || release.prerelease !== false || !versionPattern.test(release.tag_name) || release.html_url !== `https://github.com/${repositories[tool]}/releases/tag/${release.tag_name}` || !Array.isArray(release.assets)) throw error('SETUP_RELEASE_INVALID', 'Expected official stable release metadata with a supported version tag.');
  const filename = archiveName(tool, release.tag_name, platform, arch), archive = releaseAsset(release, filename, repositories[tool]);
  const assets = [archive];
  if (tool === 'tunnel') assets.push(...[filename.replace(/\.zip$/, '-licenses.txt'), filename.replace(/\.zip$/, '.spdx.json')].map(name => releaseAsset(release, name, repositories[tool])));
  const checksums = new Map<string, string>();
  for (const asset of assets) if (asset.digest !== undefined && asset.digest !== null) {
    if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) throw error('SETUP_CHECKSUM_INVALID', 'Official release metadata has an invalid SHA-256 digest.');
    checksums.set(asset.name, asset.digest.slice(7).toLowerCase());
  }
  let checksumBytes: Buffer | undefined;
  if (assets.some(asset => !checksums.has(asset.name))) {
    const checksumName = tool === 'tunnel' ? 'SHA256SUMS.txt' : filename + '.sha256';
    const asset = releaseAsset(release, checksumName, repositories[tool]);
    checksumBytes = await getAsset(asset, META_LIMIT);
    if (asset.digest && (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest) || sha(checksumBytes) !== asset.digest.slice(7).toLowerCase())) throw error('SETUP_CHECKSUM_INVALID', 'The official checksum file failed SHA-256 verification.');
    const lines = new Map<string, string>();
    const checksumText = checksumBytes.toString('utf8').trim();
    // Official ripgrep Windows releases use certutil, POSIX uses sha256sum.
    const certutil = /^SHA256 hash of ([^\r\n]+):\r?\n([a-f0-9]{64})\r?\nCertUtil: -hashfile command completed successfully\.$/i.exec(checksumText);
    if (certutil && tool === 'rg' && certutil[1] === filename) lines.set(filename, certutil[2].toLowerCase());
    else for (const line of checksumText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
      if (!match || lines.has(match[2])) throw error('SETUP_CHECKSUM_INVALID', 'The official checksum file contains malformed or duplicate entries.');
      lines.set(match[2], match[1].toLowerCase());
    }
    for (const asset of assets) {
      const digest = lines.get(asset.name);
      if (!digest || checksums.has(asset.name) && checksums.get(asset.name) !== digest) throw error('SETUP_CHECKSUM_INVALID', 'The official checksum file does not consistently cover every required release asset.');
      checksums.set(asset.name, digest);
    }
  }
  const payloads = new Map<string, Buffer>();
  // Resolve small license/SBOM sidecars first, so an unavailable sidecar does
  // not cause a completed large archive download to be discarded.
  for (const asset of [...assets.slice(1), archive]) {
    options.onProgress?.(`${tool}: downloading and verifying ${asset.name}.`);
    // The official asset API is also used by install-tunnel.ps1 and avoids
    // stale/blocked release-page redirects on some local networks.
    const bytes = await getAsset(asset, asset === archive ? ARCHIVE_LIMIT : META_LIMIT);
    if (bytes.length !== asset.size || sha(bytes) !== checksums.get(asset.name)) throw error('SETUP_CHECKSUM_MISMATCH', 'The official dependency download did not match its published size and SHA-256. No tool was installed.');
    payloads.set(asset.name, bytes);
  }
  const members = extractMembers(payloads.get(filename)!, filename);
  const binary = tool === 'git' ? members.filter(member => member.name === 'cmd/git.exe' && member.data) : members.filter(member => member.data && path.posix.basename(member.name) === (tool === 'rg' ? 'rg' : 'tunnel-client') + (platform === 'win32' ? '.exe' : ''));
  if (binary.length !== 1) throw error('SETUP_ARCHIVE_INVALID', 'The verified archive does not contain exactly one expected executable.');
  await plainDirectory(toolsDir, true);
  const stage = path.join(toolsDir, `.setup-${directories[tool]}-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  let published = false;
  try {
    const versionDir = path.join(stage, `${release.tag_name}-${platform}-${arch}`), bin = path.join(versionDir, 'bin');
    await mkdir(bin, { recursive: true, mode: 0o700 });
    const files: { path: string; sha256: string }[] = [];
    for (const member of members) {
      const destination = path.join(bin, member.name);
      if (!within(stage, destination)) throw invalidArchive();
      if (member.data === undefined) await plainDirectory(destination, true);
      else {
        await plainDirectory(path.dirname(destination), true);
        await writeFile(destination, member.data, { flag: 'wx', mode: member.executable || member === binary[0] ? 0o755 : 0o644 });
        if (process.platform !== 'win32') await chmod(destination, member.executable || member === binary[0] ? 0o755 : 0o644);
        files.push({ path: path.relative(stage, destination).split(path.sep).join('/'), sha256: sha(member.data) });
      }
    }
    for (const [name, bytes] of payloads) await writeFile(path.join(versionDir, name), bytes, { flag: 'wx', mode: 0o600 });
    if (checksumBytes) await writeFile(path.join(versionDir, 'checksums.txt'), checksumBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(versionDir, 'release.json'), JSON.stringify(release, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const relativeBinary = path.relative(stage, path.join(bin, binary[0].name));
    const relativeArchive = path.relative(stage, path.join(versionDir, filename));
    const executable = path.join(root, relativeBinary), record: Installation = {
      version: release.tag_name, architecture: arch === 'x64' ? 'amd64' : 'arm64', platform, releaseUrl: release.html_url,
      checkedAt: new Date().toISOString(), executable: relativeBinary.split(path.sep).join('/'), executableSha256: sha(binary[0].data!),
      archive: relativeArchive.split(path.sep).join('/'), archiveSha256: checksums.get(filename)!,
      verification: 'SHA-256 verified against the same official GitHub release metadata/checksums; provenance signature not verified.', files,
    };
    await writeFile(path.join(stage, 'install.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const version = await (deps.probe ?? probeExecutable)(path.join(stage, relativeBinary));
    // The official Go client prints "0.0.14+<sha> (git sha: ...)" without a
    // program-name prefix. Check the selected release version explicitly.
    const tunnelVersion = new RegExp('^(?:tunnel-client\\s+(?:version\\s+)?)?v?' + release.tag_name.replace(/^v/, '').replaceAll('.', '\\.') + '(?:[+\\s(]|$)', 'i');
    if (!version || !(tool === 'git' ? /^git version / : tool === 'rg' ? /^ripgrep / : tunnelVersion).test(version)) throw error('SETUP_TOOL_PROBE_FAILED', 'The verified tool could not run --version on this platform. The existing installation was not changed.');
    await plainDirectory(toolsDir, false);
    try { await lstat(root); throw conflict(); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    await rename(stage, root); published = true;
    return { tool, executable, version: release.tag_name, source: 'official_release', verification: record.verification, executableSha256: record.executableSha256, archiveSha256: record.archiveSha256 };
  } finally {
    // Only this invocation's random, boundary-checked staging directory is removed.
    if (!published && within(toolsDir, stage)) { await plainDirectory(stage, false); await rm(stage, { recursive: true, force: true }); }
  }
}

type SetupOwner = { version: 1; pid: number; owner: string };
const lockFailure = () => error('SETUP_ALREADY_RUNNING', 'Another setup owns this tools directory, or its lock cannot be verified. Let an active setup finish. An empty legacy .setup.lock or interrupted recovery must be inspected locally; it is never deleted automatically.');
function processDefinitelyExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (cause) { return (cause as NodeJS.ErrnoException).code === 'ESRCH'; }
}
async function lockOwner(lock: string): Promise<{ owner: SetupOwner; bytes: Buffer; ino: bigint }> {
  await plainDirectory(lock, false);
  const info = await lstat(lock, { bigint: true });
  const bytes = await plainBytes(path.join(lock, 'owner.json'), 4096);
  const owner = JSON.parse(bytes.toString('utf8')) as SetupOwner;
  if (!owner || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.owner !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.owner)) throw lockFailure();
  return { owner, bytes, ino: info.ino };
}
async function reclaimExitedSetup(lock: string, toolsDir: string): Promise<void> {
  let observed: Awaited<ReturnType<typeof lockOwner>>;
  try { observed = await lockOwner(lock); } catch { throw lockFailure(); }
  if (!processDefinitelyExited(observed.owner.pid)) throw lockFailure();
  const claim = path.join(lock, 'reclaim.json');
  let claimed = false, isolated: string | undefined;
  try {
    // Only one reclaimer can rename a dead owner's directory. A partial or
    // abandoned recovery is kept for inspection, never treated as a new lock.
    await writeFile(claim, JSON.stringify({ pid: process.pid, owner: randomUUID() }), { flag: 'wx', mode: 0o600 }); claimed = true;
    const current = await lockOwner(lock);
    if (current.ino !== observed.ino || !current.bytes.equals(observed.bytes) || !processDefinitelyExited(current.owner.pid) || (await readdir(lock)).sort().join(',') !== 'owner.json,reclaim.json') throw lockFailure();
    const quarantine = path.join(toolsDir, '.setup-abandoned-' + randomUUID());
    if (!within(toolsDir, quarantine)) throw lockFailure();
    await rename(lock, quarantine); isolated = quarantine;
    // The moved directory belongs to the verified dead owner; no newly
    // acquired .setup.lock is touched by this cleanup.
    const moved = await lockOwner(quarantine);
    if (moved.ino !== observed.ino || !moved.bytes.equals(observed.bytes)) throw lockFailure();
    await unlink(path.join(quarantine, 'owner.json'));
    await unlink(path.join(quarantine, 'reclaim.json'));
    await rmdir(quarantine);
  } catch {
    if (claimed && !isolated) {
      // Removing this invocation's claim does not remove the owner's lock.
      try { await plainDirectory(lock, false); await unlink(claim); } catch { /* Preserve uncertain state for local inspection. */ }
    }
    throw lockFailure();
  }
}
async function acquireSetupLock(toolsDir: string): Promise<() => Promise<void>> {
  const lock = path.join(toolsDir, '.setup.lock'), owner: SetupOwner = { version: 1, pid: process.pid, owner: randomUUID() };
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    await reclaimExitedSetup(lock, toolsDir);
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (retry) { if ((retry as NodeJS.ErrnoException).code === 'EEXIST') throw lockFailure(); throw retry; }
  }
  const bytes = Buffer.from(JSON.stringify(owner) + '\n');
  try { await writeFile(path.join(lock, 'owner.json'), bytes, { flag: 'wx', mode: 0o600 }); }
  catch (cause) { try { await rmdir(lock); } catch { /* An incomplete lock is preserved for inspection. */ } throw cause; }
  const acquired = await lockOwner(lock);
  return async () => {
    const current = await lockOwner(lock);
    if (current.ino !== acquired.ino || !current.bytes.equals(bytes)) throw lockFailure();
    await unlink(path.join(lock, 'owner.json')); await rmdir(lock);
  };
}

/** Install only official portable dependencies into the selected local tools directory. */
export async function installSetupTools(options: SetupToolsOptions, deps: SetupToolsDependencies = {}): Promise<SetupToolsResult> {
  const platform = deps.platform ?? process.platform, arch = deps.arch ?? process.arch;
  if (!['win32', 'linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw error('SETUP_PLATFORM_UNSUPPORTED', 'Automatic setup supports Windows, macOS and Linux on x64 or arm64.');
  proxyAddress(options.proxyUrl);
  if (!path.isAbsolute(options.toolsDir)) throw error('SETUP_PATH_INVALID', 'toolsDir must be an absolute local directory.');
  const toolsDir = path.resolve(options.toolsDir), probe = deps.probe ?? probeExecutable, env = deps.env ?? process.env;
  let git = await discover('git', options.gitPath, platform as Platform, env, probe);
  let rg = await discover('rg', options.rgPath, platform as Platform, env, probe);
  if (!git && platform !== 'win32') throw error('SETUP_GIT_REQUIRED', platform === 'darwin'
    ? 'Git is not installed. Install Git with your system package manager (Homebrew: brew install git), then rerun setup.'
    : 'Git is not installed. Install Git with your distribution package manager (Debian/Ubuntu: apt install git; Fedora: dnf install git; Alpine: apk add git), then rerun setup.');
  await plainDirectory(toolsDir, true);
  const releaseLock = await acquireSetupLock(toolsDir);
  try {
    git ??= await install('git', toolsDir, platform as Platform, arch as Architecture, options, deps);
    rg ??= await install('rg', toolsDir, platform as Platform, arch as Architecture, options, deps);
    const tunnel = await install('tunnel', toolsDir, platform as Platform, arch as Architecture, options, deps);
    const node: SetupToolRecord = { tool: 'node', executable: process.execPath, version: process.version, source: 'current_runtime', verification: 'Current Node.js runtime; setup does not replace it.' };
    return { nodePath: node.executable, gitPath: git.executable, rgPath: rg.executable, tunnelPath: tunnel.executable, installed: [node, git, rg, tunnel] };
  } finally { await releaseLock(); }
}
