import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { installSetupTools, type SetupToolsDependencies } from '../src/setup-tools.js';
import { AppError } from '../src/errors.js';
import { setupReleaseCatalog } from '../src/setup-catalog.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Entry = { name: string; content?: string; kind?: number; deflate?: boolean };
function zip(entries: Entry[]): Buffer {
  const files: Buffer[] = [], central: Buffer[] = []; let position = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), body = Buffer.from(entry.content ?? ''), packed = entry.deflate ? deflateRawSync(body) : body, local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.deflate ? 8 : 0, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(3 * 256 + 20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(entry.deflate ? 8 : 0, 10); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(body.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((((entry.kind ?? (entry.name.endsWith('/') ? 0x4000 : 0x8000)) | 0o755) * 65536) >>> 0, 38); record.writeUInt32LE(position, 42);
    files.push(local, name, packed); central.push(record, name); position += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(position, 16);
  return Buffer.concat([...files, directory, end]);
}
function tar(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), body = Buffer.from(entry.content ?? '');
    header.write(entry.name, 0, 100); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156);
    header[156] = entry.kind ?? 48; header.write('ustar\0', 257); header.write('00', 263);
    const sum = header.reduce((total, byte) => total + byte, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
type FixtureOptions = {
  platform?: 'win32' | 'linux' | 'darwin'; arch?: 'x64' | 'arm64';
  missingGit?: boolean; missingRg?: boolean; tunnelEntries?: Entry[]; rgEntries?: Entry[];
  checksumFallback?: boolean; certutilChecksum?: boolean; corruptAsset?: boolean; duplicateChecksum?: boolean;
  metadataOrigin?: string; assetApi?: boolean; assetApiUnavailable?: boolean; invalidAssetApi?: boolean; noDigest?: boolean; failedProbe?: boolean; tunnelVersion?: string;
};
async function fixture(t: test.TestContext, options: FixtureOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'webcodex-setup-tools-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const toolsDir = path.join(root, '工具 tools'), calls: string[] = [], probes: string[] = [];
  const platform = options.platform ?? 'win32', arch = options.arch ?? 'x64';
  const systemDir = path.join(root, 'system'), gitPath = path.join(systemDir, 'git' + (platform === 'win32' ? '.exe' : ''));
  const rgPath = path.join(systemDir, 'rg' + (platform === 'win32' ? '.exe' : ''));
  const responses = new Map<string, Buffer>();
  const tunnelName = `tunnel-client-v0.0.14-${platform === 'win32' ? 'windows' : platform}-${arch === 'x64' ? 'amd64' : arch}.zip`;
  const rgName = `ripgrep-15.2.0-${arch === 'x64' ? 'x86_64' : 'aarch64'}-${platform === 'win32' ? 'pc-windows-msvc.zip' : platform === 'darwin' ? 'apple-darwin.tar.gz' : 'unknown-linux-musl.tar.gz'}`;
  const gitName = `MinGit-2.55.0.5-${arch === 'x64' ? '64-bit' : arch}.zip`;
  const exe = (name: string) => name + (platform === 'win32' ? '.exe' : '');
  for (const [repo, version, name, archive] of [
    ['openai/tunnel-client', 'v0.0.14', tunnelName, zip(options.tunnelEntries ?? [{ name: exe('tunnel-client'), content: 'synthetic tunnel executable' }])],
    ['BurntSushi/ripgrep', '15.2.0', rgName, (platform === 'win32' ? zip : tar)(options.rgEntries ?? [{ name: 'ripgrep-15.2.0/' + exe('rg'), content: 'synthetic rg executable' }])],
    ['git-for-windows/git', 'v2.55.0.windows.5', gitName, zip([{ name: 'cmd/git.exe', content: 'synthetic git executable' }, { name: 'mingw64/bin/runtime.dll', content: 'synthetic supporting library' }])],
  ] as const) {
    const assets: { name: string; size: number; digest?: string; browser_download_url: string; url?: string }[] = [];
    function add(assetName: string, bytes: Buffer, includeDigest = true) {
      const url = `https://github.com/${repo}/releases/download/${version}/${assetName}`;
      const assetApi = `https://api.github.com/repos/${repo}/releases/assets/${assets.length + 1000}`;
      assets.push({ name: assetName, size: bytes.length, ...(includeDigest ? { digest: 'sha256:' + hash(bytes) } : {}), browser_download_url: options.metadataOrigin && assetName === name ? options.metadataOrigin : url,
        ...(options.assetApi || options.invalidAssetApi ? { url: options.invalidAssetApi ? 'https://api.github.com/repos/other/project/releases/assets/1000' : assetApi } : {}) });
      responses.set(url, options.corruptAsset && assetName === tunnelName ? Buffer.from('corrupt') : bytes);
      if (options.assetApi) responses.set(assetApi, bytes);
    }
    add(name, archive, !options.checksumFallback && !options.noDigest);
    const covered: [string, Buffer][] = [[name, archive]];
    if (repo === 'openai/tunnel-client') {
      for (const sidecar of [name.replace(/\.zip$/, '-licenses.txt'), name.replace(/\.zip$/, '.spdx.json')]) {
        const bytes = Buffer.from('synthetic license/SBOM'); add(sidecar, bytes, !options.checksumFallback && !options.noDigest); covered.push([sidecar, bytes]);
      }
    }
    if (!options.noDigest) {
      const lines = covered.map(([assetName, bytes]) => hash(bytes) + '  ' + assetName);
      if (options.duplicateChecksum) lines.push(lines[0]);
      add(repo === 'openai/tunnel-client' ? 'SHA256SUMS.txt' : name + '.sha256', Buffer.from(options.certutilChecksum && repo === 'BurntSushi/ripgrep'
        ? `SHA256 hash of ${name}:\r\n${hash(archive)}\r\nCertUtil: -hashfile command completed successfully.\r\n`
        : lines.join('\n') + '\n'));
    }
    responses.set(`https://api.github.com/repos/${repo}/releases/latest`, Buffer.from(JSON.stringify({ tag_name: version, html_url: `https://github.com/${repo}/releases/tag/${version}`, draft: false, prerelease: false, assets })));
  }
  const deps: SetupToolsDependencies = {
    platform, arch, env: { PATH: systemDir },
    download: async (url, limits) => {
      calls.push(url); assert.ok(limits.maxBytes <= 128 * 1024 * 1024);
      if (options.assetApiUnavailable && /\/releases\/assets\//.test(url)) throw new AppError('SETUP_DOWNLOAD_FAILED', 'Synthetic public asset API rate limit');
      const response = responses.get(url); assert.ok(response, 'Unexpected download: ' + url); return response;
    },
    probe: async file => {
      probes.push(file);
      if (file === gitPath) return options.missingGit ? undefined : 'git version 2.45.1';
      if (file === rgPath) return options.missingRg ? undefined : 'ripgrep 15.2.0';
      if (!file.startsWith(toolsDir + path.sep) || options.failedProbe) return undefined;
      assert.match((await readFile(file)).toString(), /synthetic/);
      return path.basename(file).startsWith('tunnel-client') ? options.tunnelVersion ?? 'tunnel-client v0.0.14' : path.basename(file).startsWith('git') ? 'git version 2.55.0.windows.5' : 'ripgrep 15.2.0';
    },
  };
  return { root, toolsDir, calls, probes, responses, gitPath, rgPath, deps, options: { toolsDir } };
}

test('setup installs official portable tools with complete bytes and compatible tunnel manifest', async t => {
  const f = await fixture(t, { missingGit: true, missingRg: true });
  const result = await installSetupTools(f.options, f.deps);
  assert.equal(result.nodePath, process.execPath); assert.equal(result.installed.length, 4);
  for (const record of result.installed.slice(1)) { assert.equal(record.source, 'official_release'); assert.match(record.executableSha256!, /^[a-f0-9]{64}$/); }
  const record = JSON.parse(await readFile(path.join(f.toolsDir, 'tunnel-client', 'install.json'), 'utf8'));
  const tunnelRoot = path.join(f.toolsDir, 'tunnel-client');
  const recordedExecutable = path.resolve(tunnelRoot, record.executable.split('/').join(path.sep));
  const recordedArchive = path.resolve(tunnelRoot, record.archive.split('/').join(path.sep));
  assert.equal(path.isAbsolute(record.executable), false); assert.equal(recordedExecutable, result.tunnelPath);
  assert.equal(record.version, 'v0.0.14'); assert.equal(record.architecture, 'amd64');
  assert.equal(record.releaseUrl, 'https://github.com/openai/tunnel-client/releases/tag/v0.0.14');
  assert.equal(record.executableSha256, hash(await readFile(result.tunnelPath)));
  assert.equal(record.archiveSha256, hash(await readFile(recordedArchive)));
  assert.ok(record.files.some((file: { path: string }) => file.path.endsWith('tunnel-client.exe')));
  for (const directory of ['tunnel-client', 'git', 'ripgrep']) {
    const installed = JSON.parse(await readFile(path.join(f.toolsDir, directory, 'install.json'), 'utf8'));
    assert.equal(path.isAbsolute(installed.executable), false, directory + ' executable');
    assert.equal(path.isAbsolute(installed.archive), false, directory + ' archive');
  }
  assert.deepEqual((await readdir(f.toolsDir)).sort(), ['git', 'ripgrep', 'tunnel-client']);
});
test('verified tool installations remain reusable after moving the complete tools directory', async t => {
  const f = await fixture(t, { missingGit: true, missingRg: true });
  const installed = await installSetupTools(f.options, f.deps), calls = f.calls.length;
  const moved = path.join(f.root, 'moved tools');
  await rename(f.toolsDir, moved);
  const reused = await installSetupTools({ toolsDir: moved }, f.deps);
  assert.equal(f.calls.length, calls);
  for (const [actual, original] of [[reused.tunnelPath, installed.tunnelPath], [reused.gitPath, installed.gitPath], [reused.rgPath, installed.rgPath]]) {
    assert.equal(actual, original.replace(f.toolsDir, moved));
    await readFile(actual!);
  }
});
test('legacy absolute installation records are accepted only inside their current verified root', async t => {
  const f = await fixture(t, { missingGit: true, missingRg: true });
  await installSetupTools(f.options, f.deps); const calls = f.calls.length;
  const root = path.join(f.toolsDir, 'tunnel-client'), recordPath = path.join(root, 'install.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  record.executable = path.resolve(root, record.executable.split('/').join(path.sep));
  record.archive = path.resolve(root, record.archive.split('/').join(path.sep));
  await writeFile(recordPath, JSON.stringify(record));
  await installSetupTools(f.options, f.deps); assert.equal(f.calls.length, calls);
  record.executable = path.join(f.root, 'outside-tunnel-client');
  await writeFile(recordPath, JSON.stringify(record));
  await assert.rejects(installSetupTools(f.options, f.deps), { code: 'SETUP_INSTALL_CONFLICT' });
});
test('setup reuses verified dependencies without downloads and detects modified supporting files', async t => {
  const f = await fixture(t, { missingGit: true, missingRg: true });
  const result = await installSetupTools(f.options, f.deps), calls = f.calls.length;
  const again = await installSetupTools(f.options, f.deps);
  assert.equal(again.gitPath, result.gitPath); assert.equal(f.calls.length, calls);
  const record = JSON.parse(await readFile(path.join(f.toolsDir, 'git', 'install.json'), 'utf8'));
  const dll = record.files.find((file: { path: string }) => file.path.endsWith('.dll'));
  await writeFile(path.join(f.toolsDir, 'git', dll.path), 'tampered');
  await assert.rejects(installSetupTools(f.options, f.deps), { code: 'SETUP_INSTALL_CONFLICT' });
  assert.equal(f.calls.length, calls);
});
test('setup preserves an unknown installation rather than overwriting it', async t => {
  const f = await fixture(t); const unknown = path.join(f.toolsDir, 'tunnel-client');
  await mkdir(unknown, { recursive: true }); await writeFile(path.join(unknown, 'keep.txt'), 'preserve');
  await assert.rejects(installSetupTools(f.options, f.deps), { code: 'SETUP_INSTALL_CONFLICT' });
  assert.equal(await readFile(path.join(unknown, 'keep.txt'), 'utf8'), 'preserve'); assert.equal(f.calls.length, 0);
});
test('existing system Git and ripgrep are retained; custom missing paths fail before download', async t => {
  const f = await fixture(t); const result = await installSetupTools(f.options, f.deps);
  assert.equal(result.gitPath, f.gitPath); assert.equal(result.rgPath, f.rgPath);
  assert.equal(result.installed[1].source, 'system'); assert.ok(f.calls.every(url => url.includes('openai/tunnel-client')));
  const before = f.calls.length;
  await assert.rejects(installSetupTools({ ...f.options, rgPath: path.join(f.root, 'missing-rg') }, f.deps), { code: 'SETUP_CONFIGURED_TOOL_INVALID' });
  assert.equal(f.calls.length, before);
});
for (const platform of ['linux', 'darwin', 'win32'] as const) for (const arch of ['x64', 'arm64'] as const) {
  test(`setup selects and extracts ${platform} ${arch} official archives`, async t => {
    const f = await fixture(t, { platform, arch, missingRg: true }); const result = await installSetupTools(f.options, f.deps);
    assert.match(await readFile(result.rgPath, 'utf8'), /synthetic rg/);
    assert.equal(JSON.parse(await readFile(path.join(f.toolsDir, 'tunnel-client', 'install.json'), 'utf8')).architecture, arch === 'x64' ? 'amd64' : arch);
    assert.ok(f.calls.some(url => url.includes(platform === 'win32' ? 'pc-windows-msvc.zip' : platform === 'linux' ? 'unknown-linux-musl.tar.gz' : 'apple-darwin.tar.gz')));
  });
}
test('POSIX missing Git gives package-manager remediation without attempting installation', async t => {
  const f = await fixture(t, { platform: 'linux', missingGit: true });
  await assert.rejects(installSetupTools(f.options, f.deps), { code: 'SETUP_GIT_REQUIRED', message: /apt install git/ });
  assert.equal(f.calls.length, 0); await assert.rejects(readdir(f.toolsDir), { code: 'ENOENT' });
});
test('checksum-file fallback verifies every required archive and sidecar', async t => {
  const f = await fixture(t, { checksumFallback: true, missingRg: true });
  const result = await installSetupTools(f.options, f.deps); assert.ok(result.tunnelPath);
  assert.ok(f.calls.some(url => url.endsWith('SHA256SUMS.txt'))); assert.ok(f.calls.some(url => url.endsWith('.zip.sha256')));
});
test('official ripgrep certutil checksums and deflated ZIP bytes install without changing contents', async t => {
  const content = 'synthetic executable repeated content\n'.repeat(100);
  const f = await fixture(t, { checksumFallback: true, certutilChecksum: true, missingRg: true,
    rgEntries: [{ name: 'rg.exe', content, deflate: true }], tunnelEntries: [{ name: 'tunnel-client.exe', content, deflate: true }] });
  const result = await installSetupTools(f.options, f.deps);
  assert.equal(await readFile(result.rgPath, 'utf8'), content); assert.equal(await readFile(result.tunnelPath, 'utf8'), content);
});
test('setup uses the matching official asset API when release metadata provides it', async t => {
  const f = await fixture(t, { assetApi: true });
  assert.ok((await installSetupTools(f.options, f.deps)).tunnelPath);
  assert.ok(f.calls.some(url => /\/releases\/assets\//.test(url)));
  assert.ok(f.calls.every(url => url.startsWith('https://api.github.com/repos/openai/tunnel-client/')));
});
test('an unavailable public asset API falls back to the exact official release URL and retains SHA verification', async t => {
  const f = await fixture(t, { assetApi: true, assetApiUnavailable: true });
  assert.ok((await installSetupTools(f.options, f.deps)).tunnelPath);
  assert.ok(f.calls.some(url => /\/releases\/assets\//.test(url)));
  assert.ok(f.calls.some(url => url.startsWith('https://github.com/openai/tunnel-client/releases/download/v0.0.14/')));
  const corrupt = await fixture(t, { assetApi: true, assetApiUnavailable: true, corruptAsset: true });
  await assert.rejects(installSetupTools(corrupt.options, corrupt.deps), { code: 'SETUP_CHECKSUM_MISMATCH' });
});
test('official tunnel semantic version with build metadata is accepted and a different release is rejected', async t => {
  const f = await fixture(t, { tunnelVersion: '0.0.14+0123456789abcdef (git sha: 0123456789abcdef)' });
  assert.ok((await installSetupTools(f.options, f.deps)).tunnelPath);
  const different = await fixture(t, { tunnelVersion: '0.0.140+0123456789abcdef (git sha: 0123456789abcdef)' });
  await assert.rejects(installSetupTools(different.options, different.deps), { code: 'SETUP_TOOL_PROBE_FAILED' });
});
test('anonymous metadata rate limiting uses the pinned official catalog but still rejects corrupt bytes', async t => {
  const f = await fixture(t), calls: string[] = [], progress: string[] = [];
  const first = setupReleaseCatalog.tunnel.assets.find(asset => asset.name === 'tunnel-client-v0.0.14-windows-amd64-licenses.txt')!;
  assert.ok(first);
  const deps = { ...f.deps, download: async (url: string) => {
    calls.push(url);
    if (url.endsWith('/releases/latest')) throw new AppError('SETUP_DOWNLOAD_FAILED', 'Synthetic anonymous API limit');
    assert.equal(url, first.url);
    return Buffer.alloc(first.size);
  } };
  await assert.rejects(installSetupTools({ ...f.options, onProgress: message => progress.push(message) }, deps), { code: 'SETUP_CHECKSUM_MISMATCH' });
  assert.equal(calls.length, 2); assert.ok(progress.some(message => message.includes('bundled verified release v0.0.14')));
  assert.deepEqual(await readdir(f.toolsDir), []);
});
test('metadata source-policy errors never fall back to the bundled catalog', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(installSetupTools(f.options, { ...f.deps, download: async () => { calls++; throw new AppError('SETUP_SOURCE_DENIED', 'Synthetic unexpected origin'); } }), { code: 'SETUP_SOURCE_DENIED' });
  assert.equal(calls, 1);
});
for (const [title, options, code] of [
  ['corrupt downloaded bytes', { corruptAsset: true }, 'SETUP_CHECKSUM_MISMATCH'],
  ['missing checksum evidence', { noDigest: true }, 'SETUP_RELEASE_UNSUPPORTED'],
  ['duplicate checksum entries', { checksumFallback: true, duplicateChecksum: true }, 'SETUP_CHECKSUM_INVALID'],
  ['unofficial asset URL', { metadataOrigin: 'https://example.invalid/tunnel-client.zip' }, 'SETUP_SOURCE_DENIED'],
  ['mismatched asset API repository', { invalidAssetApi: true }, 'SETUP_SOURCE_DENIED'],
  ['failed executable probe', { failedProbe: true }, 'SETUP_TOOL_PROBE_FAILED'],
] as const) test(`setup rejects ${title} without publishing`, async t => {
  const f = await fixture(t, options);
  await assert.rejects(installSetupTools(f.options, f.deps), { code });
  assert.deepEqual(await readdir(f.toolsDir), []);
});
for (const entry of [
  { name: '../escape.exe', content: 'bad' }, { name: '/absolute.exe', content: 'bad' },
  { name: 'C:/escape.exe', content: 'bad' }, { name: 'dir\\escape.exe', content: 'bad' },
  { name: 'link', kind: 0xa000, content: 'outside' }, { name: 'NUL.txt', content: 'bad' },
  { name: 'name. ', content: 'bad' }, { name: 'directory', kind: 0x4000 },
] as Entry[]) test(`setup refuses unsafe ZIP member ${JSON.stringify(entry.name)}`, async t => {
  const f = await fixture(t, { tunnelEntries: [{ name: 'tunnel-client.exe', content: 'synthetic tunnel' }, entry] });
  await assert.rejects(installSetupTools(f.options, f.deps), { code: 'SETUP_ARCHIVE_INVALID' });
  assert.deepEqual(await readdir(f.toolsDir), []);
});
test('setup refuses duplicate archive destinations and file/directory aliases', async t => {
  for (const entries of [
    [{ name: 'tunnel-client.exe' }, { name: 'TUNNEL-CLIENT.EXE' }],
    [{ name: 'tunnel-client.exe' }, { name: 'a', content: 'file' }, { name: 'a/child', content: 'child' }],
  ]) {
    const f = await fixture(t, { tunnelEntries: entries });
    await assert.rejects(installSetupTools(f.options, f.deps), { code: 'SETUP_ARCHIVE_INVALID' });
  }
});
for (const kind of [49, 50, 51, 52, 54, 120]) test(`setup refuses TAR entry type ${kind} including links and extended metadata`, async t => {
  const f = await fixture(t, { platform: 'linux', missingRg: true, rgEntries: [{ name: 'rg', content: 'synthetic rg' }, { name: 'unsupported', kind }] });
  await assert.rejects(installSetupTools(f.options, f.deps), { code: 'SETUP_ARCHIVE_INVALID' });
  assert.deepEqual(await readdir(f.toolsDir), []);
});
test('setup rejects a second installer and invalid proxy before any download', async t => {
  const f = await fixture(t); await mkdir(path.join(f.toolsDir, '.setup.lock'), { recursive: true });
  await assert.rejects(installSetupTools(f.options, f.deps), { code: 'SETUP_ALREADY_RUNNING' });
  await assert.rejects(installSetupTools({ ...f.options, proxyUrl: 'http://user:secret@example.invalid' }, f.deps), { code: 'SETUP_PROXY_INVALID' });
  assert.equal(f.calls.length, 0);
});
test('setup retains a live owner and an unknown legacy lock', async t => {
  const f = await fixture(t), lock = path.join(f.toolsDir, '.setup.lock');
  await mkdir(lock, { recursive: true });
  const bytes = JSON.stringify({ version: 1, pid: process.pid, owner: '00000000-0000-4000-8000-000000000001' });
  await writeFile(path.join(lock, 'owner.json'), bytes);
  await assert.rejects(installSetupTools(f.options, f.deps), { code: 'SETUP_ALREADY_RUNNING' });
  assert.equal(await readFile(path.join(lock, 'owner.json'), 'utf8'), bytes); assert.equal(f.calls.length, 0);
});
test('setup recovers a verified dead owner after a real interrupted download process', { timeout: 30000 }, async t => {
  const f = await fixture(t), module = new URL('../src/setup-tools.js', import.meta.url).href;
  const source = `import {installSetupTools} from ${JSON.stringify(module)};
    await installSetupTools({toolsDir:${JSON.stringify(f.toolsDir)}}, {
      platform:'win32',arch:'x64',env:{PATH:''},
      download:async()=>{process.stdout.write('LOCKED\\n');await new Promise(()=>{setInterval(()=>{},1000);});},
      probe:async()=>undefined
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = once(child, 'close');
  await new Promise<void>((resolve, reject) => {
    let output = '', diagnostic = '';
    const timer = setTimeout(() => reject(new Error('Child did not reach its locked download')), 15000);
    child.on('error', cause => { clearTimeout(timer); reject(cause); });
    child.stderr.on('data', bytes => { diagnostic += bytes.toString(); });
    child.stdout.on('data', bytes => { output += bytes.toString(); if (output.includes('LOCKED\n')) { clearTimeout(timer); resolve(); } });
    child.once('close', () => { clearTimeout(timer); if (!output.includes('LOCKED\n')) reject(new Error('Child exited before download: ' + diagnostic)); });
  });
  const owner = JSON.parse(await readFile(path.join(f.toolsDir, '.setup.lock', 'owner.json'), 'utf8'));
  assert.equal(owner.pid, child.pid); child.kill(); await exit;
  const result = await installSetupTools(f.options, f.deps);
  assert.ok(result.tunnelPath); assert.deepEqual(await readdir(f.toolsDir), ['tunnel-client']);
});
