import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify, parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

const exec = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?$/;
export const RELEASE_DOCUMENTS = [
  'README.md', 'README.en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'docs/README.md', 'docs/quickstart.md', 'docs/releasing.md', 'docs/chatgpt-setup.md', 'docs/local-configuration.md', 'docs/local-panel.md',
  'docs/codex-emergency.md', 'docs/file-workflow.md', 'docs/file-writeback.md', 'docs/original-files.md',
  'docs/current-acceptance.md', 'docs/ssh-troubleshooting.md', 'docs/tools.json',
  'docs/architecture.md', 'docs/file-reading-alternatives.md', 'docs/implementation-status.md', 'docs/pdf-reading-prototype.md',
  'docs/project-review-20260911.md', 'docs/protocol-diagnostics.md', 'docs/reading-relay-prototype.md', 'docs/roadmap.md',
  'docs/task-workflow.md', 'docs/testing.md',
  'examples/config.example.json', 'examples/config.example.toml',
  'scripts/install-tunnel.ps1', 'scripts/resolve-tunnel-install.mjs',
];

function child(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.startsWith('/')
    || relative.split('/').some(part => !part || part === '.' || part === '..') || relative.includes(':')) {
    throw new Error('Release paths must be plain relative paths.');
  }
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('Release path escaped its root.');
  return resolved;
}

async function plainFile(root, relative) {
  const target = child(root, relative);
  const parts = relative.split('/');
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Release inputs cannot contain linked directories: ' + relative);
  }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error('Release input is not a bounded ordinary file: ' + relative);
  const handle = await open(target, 'r');
  try {
    const before = await handle.stat();
    // Some Windows runtimes report dev=0 for path stat but the volume serial
    // for descriptor stat; inode and bounded metadata still identify the file.
    if (before.ino !== stat.ino || before.size !== stat.size) throw new Error('Release input changed: ' + relative);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Release input changed: ' + relative);
    return bytes;
  } finally { await handle.close(); }
}

async function sourceModules(root, directory = 'src') {
  const entries = await readdir(child(root, directory), { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = directory + '/' + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Linked source entries cannot be packaged: ' + relative);
    if (entry.isDirectory()) result.push(...await sourceModules(root, relative));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) result.push(relative);
  }
  return result;
}

export function releaseMetadata(project, lock, files) {
  if (project.name !== 'webcodex-mcp' || !versionPattern.test(project.version)
    || lock.lockfileVersion !== 3 || lock.name !== project.name || lock.version !== project.version
    || JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(project.dependencies)) {
    throw new Error('Release metadata and package-lock.json must agree.');
  }
  const metadata = {};
  for (const key of ['name', 'version', 'description', 'type', 'engines', 'bin', 'license', 'keywords', 'repository', 'homepage', 'bugs', 'dependencies']) {
    if (project[key] !== undefined) metadata[key] = structuredClone(project[key]);
  }
  for (const version of Object.values(metadata.dependencies ?? {})) {
    if (!versionPattern.test(version)) throw new Error('Release dependencies must use exact pinned versions.');
  }
  if (metadata.type !== 'module' || metadata.bin?.['webcodex-mcp'] !== 'dist/src/cli.js') throw new Error('Unexpected release CLI entry point.');
  metadata.files = [...files, 'npm-shrinkwrap.json'].sort();
  metadata.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/' };
  const root = structuredClone(lock.packages['']);
  delete root.devDependencies;
  const packages = { '': root };
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name || item.dev === true) continue;
    if (!name.startsWith('node_modules/') || item.link || !versionPattern.test(item.version)
      || typeof item.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(item.integrity)
      || typeof item.resolved !== 'string' || !item.resolved.startsWith('https://registry.npmjs.org/')) {
      throw new Error('Only registry dependencies with locked integrity may enter the release.');
    }
    const url = new URL(item.resolved);
    if (url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.search || url.hash) throw new Error('Invalid locked registry URL.');
    packages[name] = structuredClone(item);
  }
  return { metadata, shrinkwrap: { name: project.name, version: project.version, lockfileVersion: 3, requires: true, packages } };
}

/** A second audit reads the actual tar bytes, not only npm's pack-list report. */
export function inspectTarball(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  const files = new Map();
  let offset = 0, extended = {};
  const string = bytes => bytes.toString('utf8').split('\0')[0];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const checksum = parseInt(string(header.subarray(148, 156)).trim(), 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (actual !== checksum) throw new Error('Invalid release tar header checksum.');
    const size = parseInt(string(header.subarray(124, 136)).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid release tar entry size.');
    const body = tar.subarray(offset + 512, offset + 512 + size);
    const type = string(header.subarray(156, 157));
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      extended = {};
      for (let pos = 0; pos < body.length;) {
        const separator = body.indexOf(32, pos);
        const length = Number(body.subarray(pos, separator).toString('ascii'));
        if (separator < pos || !Number.isSafeInteger(length) || length <= separator - pos + 1 || pos + length > body.length || body[pos + length - 1] !== 10) throw new Error('Invalid release PAX header.');
        const record = body.subarray(separator + 1, pos + length - 1).toString('utf8');
        const equals = record.indexOf('=');
        if (equals < 1) throw new Error('Invalid release PAX record.');
        extended[record.slice(0, equals)] = record.slice(equals + 1);
        pos += length;
      }
      continue;
    }
    if (type !== '0' && type !== '') throw new Error('Release tarball may only contain ordinary files.');
    const prefix = string(header.subarray(345, 500));
    const name = extended.path ?? (prefix ? prefix + '/' : '') + string(header.subarray(0, 100));
    if (extended.size !== undefined && Number(extended.size) !== size) throw new Error('Unexpected release PAX size.');
    extended = {};
    if (!name.startsWith('package/')) throw new Error('Unexpected release tar prefix.');
    const relative = name.slice('package/'.length);
    child(os.tmpdir(), relative);
    if (files.has(relative)) throw new Error('Duplicate release tar entry.');
    files.set(relative, Buffer.from(body));
  }
  if (!files.size || Object.keys(extended).length) throw new Error('Incomplete release tarball.');
  return files;
}

export async function findNpmCli() {
  if (process.env.npm_execpath) {
    const candidate = path.resolve(process.env.npm_execpath);
    if (path.basename(candidate) === 'npm-cli.js' && (await lstat(candidate)).isFile()) return candidate;
  }
  const require = createRequire(import.meta.url);
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  try { candidates.push(require.resolve('npm/bin/npm-cli.js')); } catch {}
  for (const candidate of candidates) { try { if ((await lstat(candidate)).isFile()) return candidate; } catch {} }
  throw new Error('Cannot find npm-cli.js. Run the release command through npm run package:release.');
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

/** Store already-compressed tgz bytes in a portable, deterministic ZIP. */
export function installerZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [filename, bytes] of files) {
    if (!/^[A-Za-z0-9_.-]+$/.test(filename) || !Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024) throw new Error('Invalid installer archive entry.');
    const name = Buffer.from(filename), crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); // 1980-01-01; timestamps do not affect release reproducibility.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(entry, name); offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function createReleasePackage({ root = projectRoot, output, installer = false }) {
  root = await realpath(root);
  const project = JSON.parse(await plainFile(root, 'package.json'));
  const lock = JSON.parse(await plainFile(root, 'package-lock.json'));
  const contents = new Map();
  const add = async relative => contents.set(relative, await plainFile(root, relative));
  for (const file of RELEASE_DOCUMENTS) await add(file);
  const sources = await sourceModules(root);
  if (!sources.includes('src/cli.ts') || !sources.includes('src/version.ts')) throw new Error('Release source entry points are missing.');
  for (const source of sources) {
    const compiled = 'dist/' + source.replace(/\.ts$/, '.js');
    const sourceStat = await lstat(child(root, source)), compiledStat = await lstat(child(root, compiled));
    if (compiledStat.mtimeMs + 2 < sourceStat.mtimeMs) throw new Error('Compiled source is stale; run npm run build: ' + compiled);
    await add(compiled);
  }
  const versionSource = contents.get('dist/src/version.js').toString('utf8');
  if (!versionSource.includes("export const VERSION = '" + project.version + "';")) throw new Error('Compiled version differs from package.json; run npm run build.');
  const manifestPath = `dist/src/assets/document-widget-${project.version}.json`;
  await add(manifestPath);
  const manifest = JSON.parse(contents.get(manifestPath));
  if (manifest.schema_version !== 1 || manifest.version !== project.version || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || manifest.file !== `document-widget-${project.version}-${manifest.sha256}.js`
    || !Number.isSafeInteger(manifest.size_bytes) || manifest.size_bytes < 1 || manifest.size_bytes > 5 * 1024 * 1024) throw new Error('Invalid current document widget manifest.');
  const widgetPath = 'dist/src/assets/' + manifest.file;
  await add(widgetPath);
  if (contents.get(widgetPath).length !== manifest.size_bytes || digest(contents.get(widgetPath)) !== manifest.sha256) throw new Error('Current document widget bytes do not match the manifest.');
  await add('dist/src/assets/PDFJS-NOTICES.txt');
  const { metadata, shrinkwrap } = releaseMetadata(project, lock, [...contents.keys()]);
  contents.set('package.json', Buffer.from(JSON.stringify(metadata, null, 2) + '\n'));
  contents.set('npm-shrinkwrap.json', Buffer.from(JSON.stringify(shrinkwrap, null, 2) + '\n'));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'webcodex-release-'));
  try {
    const stage = path.join(scratch, 'package');
    await mkdir(stage);
    for (const [relative, bytes] of contents) {
      const target = child(stage, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: relative === 'dist/src/cli.js' ? 0o755 : 0o644 });
    }
    const npm = await findNpmCli();
    const result = await exec(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--offline', '--cache', path.join(scratch, 'cache'), '--pack-destination', scratch], { cwd: stage, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const packed = JSON.parse(result.stdout);
    const filename = `${project.name}-${project.version}.tgz`;
    if (!Array.isArray(packed) || packed.length !== 1 || packed[0].filename !== filename) throw new Error('npm pack returned an unexpected artifact.');
    const bytes = await readFile(path.join(scratch, filename));
    const actual = inspectTarball(bytes);
    if (actual.size !== contents.size) throw new Error('Release tarball differs from its allowlist.');
    for (const [relative, expected] of contents) {
      if (!actual.get(relative)?.equals(expected)) throw new Error('Release tarball entry differs from staged input: ' + relative);
    }
    const report = { name: project.name, version: project.version, filename, size_bytes: bytes.length, sha256: digest(bytes),
      files: [...actual].sort(([a], [b]) => a.localeCompare(b)).map(([file, value]) => ({ path: file, size_bytes: value.length, sha256: digest(value) })) };
    const outputs = new Map([[filename, bytes], [filename + '.sha256', Buffer.from(`${report.sha256}  ${filename}\n`)]]);
    let checksums = `${report.sha256}  ${filename}\n`;
    if (installer) {
      const archiveFiles = new Map();
      for (const script of ['install.cmd', 'install.ps1', 'install.sh']) {
        const data = await plainFile(root, 'distribution/' + script);
        archiveFiles.set(script, script.endsWith('.sh') ? Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n')) : data);
      }
      archiveFiles.set(filename, bytes);
      archiveFiles.set('README-INSTALL.txt', Buffer.from(`WebCodex ${project.version}\n\n` +
        'Windows: 解压到普通文件夹，双击 install.cmd。不要在 ZIP 预览窗口中直接运行。\n' +
        'macOS / Linux: 解压后在终端运行 sh install.sh。\n' +
        '安装程序准备本机运行环境与配置，然后打开本机面板；ChatGPT 的账户、密钥和隧道仍须由你配置。\n\n' +
        'Windows: Extract the whole ZIP, then double-click install.cmd.\n' +
        'macOS / Linux: Extract the whole ZIP, then run sh install.sh in that directory.\n' +
        'The installer prepares the local runtime and configuration. Configure your ChatGPT account and tunnel in the local panel.\n' +
        'Quick start / 快速开始: https://github.com/xq3427/WebCodex/blob/main/docs/quickstart.md\n'));
      archiveFiles.set('SHA256SUMS', Buffer.from([...archiveFiles].map(([name, data]) => `${digest(data)}  ${name}\n`).join('')));
      const archive = installerZip(archiveFiles), archiveName = `WebCodex-${project.version}-setup.zip`;
      report.installer = { filename: archiveName, size_bytes: archive.length, sha256: digest(archive), files: [...archiveFiles.keys()] };
      outputs.set(archiveName, archive); checksums += `${report.installer.sha256}  ${archiveName}\n`;
    }
    outputs.set('SHA256SUMS', Buffer.from(checksums));
    outputs.set(filename + '.manifest.json', Buffer.from(JSON.stringify(report, null, 2) + '\n'));
    const destination = path.resolve(output ?? path.join(root, 'release'));
    await mkdir(destination, { recursive: true });
    if ((await lstat(destination)).isSymbolicLink()) throw new Error('Release output cannot be a symbolic link.');
    for (const name of outputs.keys()) {
      try { await lstat(path.join(destination, name)); throw Object.assign(new Error('Release output already exists: ' + name), { code: 'EEXIST' }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const [name, data] of outputs) await writeFile(path.join(destination, name), data, { flag: 'wx' });
    return report;
  } finally {
    // Only this function's freshly created temporary directory is removed.
    if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('webcodex-release-')) throw new Error('Unsafe release scratch cleanup target.');
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { output: { type: 'string' }, installer: { type: 'boolean' } }, allowPositionals: false });
    process.stdout.write(JSON.stringify(await createReleasePackage({ output: values.output, installer: values.installer }), null, 2) + '\n');
  } catch (error) { process.stderr.write('Release packaging failed: ' + error.message + '\n'); process.exitCode = 1; }
}
