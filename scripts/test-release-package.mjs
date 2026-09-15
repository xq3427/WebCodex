import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createReleasePackage, findNpmCli, inspectTarball, RELEASE_DOCUMENTS, releaseMetadata } from './package-release.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function scratch(t) {
  const temporaryRoot = await realpath(os.tmpdir());
  const dir = await mkdtemp(path.join(temporaryRoot, 'webcodex-release-test-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), temporaryRoot);
    assert.ok(path.basename(dir).startsWith('webcodex-release-test-'));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
async function put(dir, file, data) {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), data);
}
async function fixture(t) {
  const dir = await scratch(t);
  const metadata = { name: 'webcodex-mcp', version: '0.1.0-preview.1', private: true, type: 'module',
    scripts: { postinstall: 'DO_NOT_RUN', prepare: 'DO_NOT_RUN' }, devDependencies: { 'private-dev-tool': '1.0.0' },
    bin: { 'webcodex-mcp': 'dist/src/cli.js' }, dependencies: {}, license: 'MIT' };
  await put(dir, 'package.json', JSON.stringify(metadata));
  await put(dir, 'package-lock.json', JSON.stringify({ name: metadata.name, version: metadata.version, lockfileVersion: 3,
    packages: { '': { name: metadata.name, version: metadata.version, dependencies: {}, devDependencies: metadata.devDependencies },
      'node_modules/private-dev-tool': { dev: true, version: '1.0.0' } } }));
  for (const file of RELEASE_DOCUMENTS) await put(dir, file, 'Synthetic release fixture\n');
  for (const name of ['cli', 'version']) await put(dir, `src/${name}.ts`, '// source fixture\n');
  await put(dir, 'dist/src/cli.js', '#!/usr/bin/env node\nconsole.log("Synthetic release fixture");\n');
  await put(dir, 'dist/src/version.js', `export const VERSION = '${metadata.version}';\n`);
  const widget = Buffer.from('globalThis.SYNTHETIC_WIDGET = true;');
  const manifest = { schema_version: 1, version: metadata.version, file: `document-widget-${metadata.version}-${sha256(widget)}.js`, sha256: sha256(widget), size_bytes: widget.length };
  await put(dir, `dist/src/assets/document-widget-${metadata.version}.json`, JSON.stringify(manifest));
  await put(dir, `dist/src/assets/${manifest.file}`, widget);
  await put(dir, 'dist/src/assets/PDFJS-NOTICES.txt', 'Synthetic license notice');
  return { dir, metadata, manifest };
}

test('release pack uses an allowlist and audits the actual archive despite private files and stale dist outputs', async t => {
  const { dir, manifest } = await fixture(t);
  const excluded = ['.webcodex/config.toml', '.git/config', 'private-image.png', 'test/private.ts', 'dist/test/private.js',
    'dist/src/removed-module.js', 'dist/src/cli.js.map', 'dist/src/cli.d.ts', 'dist/src/assets/document-widget-old.js', 'node_modules/private/config.json'];
  for (const file of excluded) await put(dir, file, 'SYNTHETIC_MUST_NOT_PUBLISH');
  const output = path.join(dir, 'output');
  const report = await createReleasePackage({ root: dir, output });
  const bytes = await readFile(path.join(output, report.filename));
  const files = inspectTarball(bytes);
  assert.equal(report.sha256, sha256(bytes));
  assert.equal(report.files.length, files.size);
  assert.ok(files.has('dist/src/assets/' + manifest.file));
  for (const file of excluded) assert.equal(files.has(file), false, file);
  for (const value of files.values()) assert.ok(!value.includes(Buffer.from('SYNTHETIC_MUST_NOT_PUBLISH')));
  const metadata = JSON.parse(files.get('package.json'));
  assert.equal(metadata.private, undefined);
  assert.equal(metadata.scripts, undefined);
  assert.equal(metadata.devDependencies, undefined);
  const lock = JSON.parse(files.get('npm-shrinkwrap.json'));
  assert.deepEqual(Object.keys(lock.packages), ['']);
  assert.equal(lock.packages[''].devDependencies, undefined);
  assert.equal(await readFile(path.join(output, report.filename + '.sha256'), 'utf8'), `${report.sha256}  ${report.filename}\n`);
  assert.deepEqual(JSON.parse(await readFile(path.join(output, report.filename + '.manifest.json'), 'utf8')), report);
  await assert.rejects(createReleasePackage({ root: dir, output }), { code: 'EEXIST' });
  assert.equal(sha256(await readFile(path.join(output, report.filename))), report.sha256);
});

test('release rejects a stale compiled source before packing', async t => {
  const { dir } = await fixture(t);
  const future = new Date(Date.now() + 60_000);
  await utimes(path.join(dir, 'src/cli.ts'), future, future);
  await assert.rejects(createReleasePackage({ root: dir, output: path.join(dir, 'output') }), /Compiled source is stale/);
});

test('release rejects corrupt widget bytes instead of including an older asset', async t => {
  const { dir, manifest } = await fixture(t);
  await put(dir, 'dist/src/assets/' + manifest.file, 'corrupt current widget');
  await assert.rejects(createReleasePackage({ root: dir, output: path.join(dir, 'output') }), /do not match the manifest/);
});

test('release rejects an unsafe widget reference before opening it', async t => {
  const { dir, metadata, manifest } = await fixture(t);
  await put(dir, `dist/src/assets/document-widget-${metadata.version}.json`, JSON.stringify({ ...manifest, file: '../../private.txt' }));
  await assert.rejects(createReleasePackage({ root: dir, output: path.join(dir, 'output') }), /Invalid current document widget manifest/);
});

test('release dependency lock preserves exact production packages and rejects local or credential-bearing origins', () => {
  const project = { name: 'webcodex-mcp', version: '0.1.0', type: 'module', bin: { 'webcodex-mcp': 'dist/src/cli.js' }, dependencies: { test: '1.0.0' } };
  const item = { version: '1.0.0', resolved: 'https://registry.npmjs.org/test/-/test-1.0.0.tgz', integrity: 'sha512-YWJjZA==' };
  const lock = { name: project.name, version: project.version, lockfileVersion: 3, packages: { '': { dependencies: project.dependencies }, 'node_modules/test': item } };
  assert.deepEqual(releaseMetadata(project, lock, []).shrinkwrap.packages['node_modules/test'], item);
  for (const resolved of ['file:../private', 'https://user:password@registry.npmjs.org/test.tgz', 'https://registry.npmjs.org/test.tgz?token=private', 'https://registry.npmjs.org.evil.invalid/test.tgz']) {
    const changed = structuredClone(lock); changed.packages['node_modules/test'].resolved = resolved;
    assert.throws(() => releaseMetadata(project, changed, []));
  }
});

test('installer ZIP is flat, self-contained, uses LF for the shell script and carries matching checksums', async t => {
  const { dir } = await fixture(t);
  for (const script of ['install.cmd', 'install.ps1', 'install.sh']) await put(dir, 'distribution/' + script, 'SYNTHETIC INSTALLER\r\n');
  const output = path.join(dir, 'output');
  const report = await createReleasePackage({ root: dir, output, installer: true });
  const zip = await readFile(path.join(output, report.installer.filename));
  assert.equal(report.installer.sha256, sha256(zip));
  const files = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8), size = zip.readUInt32LE(offset + 18), nameSize = zip.readUInt16LE(offset + 26), extraSize = zip.readUInt16LE(offset + 28);
    assert.equal(method, 0); assert.equal(extraSize, 0);
    const name = zip.subarray(offset + 30, offset + 30 + nameSize).toString('utf8');
    assert.match(name, /^[A-Za-z0-9_.-]+$/); assert.equal(files.has(name), false);
    files.set(name, zip.subarray(offset + 30 + nameSize, offset + 30 + nameSize + size));
    offset += 30 + nameSize + size;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), files.size);
  assert.deepEqual([...files.keys()], report.installer.files);
  assert.equal(files.size, 6);
  assert.equal(files.get('install.sh').includes(13), false);
  assert.equal(sha256(files.get(report.filename)), report.sha256);
  for (const line of files.get('SHA256SUMS').toString('utf8').trim().split('\n')) {
    const [hash, name] = line.split('  '); assert.equal(sha256(files.get(name)), hash);
  }
  assert.equal(await readFile(path.join(output, 'SHA256SUMS'), 'utf8'), `${report.sha256}  ${report.filename}\n${report.installer.sha256}  ${report.installer.filename}\n`);
});

test('current tarball installs with production dependencies and its real CLI checks configuration and bundled assets', { timeout: 180_000 }, async t => {
  const dir = await scratch(t);
  const report = await createReleasePackage({ root, output: path.join(dir, 'artifacts') });
  const tarball = path.join(dir, 'artifacts', report.filename);
  const prefix = path.join(dir, 'installed');
  const npm = await findNpmCli();
  // npm ci caches tarballs but may never fetch package metadata. A clean CI
  // runner still needs that metadata when installing a separately packed tgz.
  // Explicit offline mode remains available for a previously populated cache.
  const cacheMode = process.env.WEBCODEX_PACKAGE_TEST_OFFLINE === '1' ? '--offline' : '--prefer-offline';
  await exec(process.execPath, [npm, 'install', '--prefix', prefix, '--ignore-scripts', cacheMode, '--no-audit', '--no-fund', tarball],
    { cwd: dir, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const packageRoot = path.join(prefix, 'node_modules', 'webcodex-mcp');
  const cli = path.join(packageRoot, 'dist', 'src', 'cli.js');
  const run = args => exec(process.execPath, [cli, ...args], { cwd: dir, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const help = await run(['--help']);
  assert.ok(help.stdout.includes('WebCodex MCP ' + report.version));
  assert.ok(help.stdout.includes('connect'));
  const workspace = path.join(dir, 'workspace 中文 with spaces');
  await mkdir(workspace);
  const config = path.join(dir, 'configuration', 'config.toml');
  assert.equal(JSON.parse((await run(['init', '--workspace', workspace, '--config', config])).stdout).ok, true);
  assert.equal(JSON.parse((await run(['config', 'validate', '--config', config])).stdout).ok, true);
  // Git/ripgrep are optional installation prerequisites outside this package.
  // Doctor may report their absence, but must load the installed widget correctly.
  let doctor;
  try { doctor = await run(['doctor', '--config', config]); } catch (error) { doctor = error; }
  const status = JSON.parse(doctor.stdout);
  assert.equal(status.version, report.version);
  assert.equal(status.document_widget.ok, true);
  assert.equal(status.document_widget.version, report.version);
  assert.equal(status.workspaces[0].exists, true);
  assert.equal(status.execution_mode, 'trusted-host');
  assert.equal(status.execution_command_policy, 'all');
  const accessStatus = JSON.parse((await run(['access', 'check', '--config', config])).stdout);
  assert.equal(accessStatus.full_access_ready, true);
  assert.equal(accessStatus.execution.process_probe, 'passed');
  assert.equal(accessStatus.workspaces[0].write_probe, 'created-read-verified-deleted');
  for (const file of RELEASE_DOCUMENTS) assert.ok((await lstat(path.join(packageRoot, file))).isFile(), file);
  const installed = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(packageRoot, 'npm-shrinkwrap.json'), 'utf8'));
  const installedRequire = createRequire(path.join(packageRoot, 'package.json'));
  for (const [name, version] of Object.entries(installed.dependencies)) {
    // npm can hoist dependencies; resolve from the installed package rather than
    // assuming one node_modules layout.
    let dependency;
    for (const search of installedRequire.resolve.paths(name) ?? []) {
      try { const candidate = JSON.parse(await readFile(path.join(search, name, 'package.json'), 'utf8')); if (candidate.name === name) { dependency = candidate; break; } } catch {}
    }
    assert.equal(dependency?.version, version);
    assert.equal(lock.packages['node_modules/' + name].version, version);
  }
  t.diagnostic(`Installed ${report.filename}; ${report.files.length} audited files; widget and real CLI passed.`);
});
