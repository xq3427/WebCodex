import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Run only file-symlink scenarios. Never change Windows privileges, system
// settings, production configuration, or the running tunnel's state database.
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const args = ['--test', '--test-concurrency=1', '--test-name-pattern=file symlink',
  path.join(root, 'dist/test/execution-environment.test.js'),
  path.join(root, 'dist/test/project-context.test.js')];
const result = spawnSync(process.execPath, args, {
  cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, WEBCODEX_REQUIRE_FILE_SYMLINK_TESTS: '1' },
});
const stdout = result.stdout ?? '', stderr = result.stderr ?? '';
process.stdout.write(stdout); process.stderr.write(stderr);
const count = name => { const value = stdout.match(new RegExp('^# ' + name + ' (\\d+)\\s*$', 'm')); return value ? Number(value[1]) : null; };
const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(name => [name, count(name)]));
const passed = result.status === 0 && counts.tests === 2 && counts.pass === 2 && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0;
const report = { completed_at: new Date().toISOString(), version, platform: process.platform, node: process.version, pid: process.pid,
  strict_file_symlinks: true, ...counts, child_exit_code: result.status, error_code: result.error?.code ?? null, passed };
const directory = path.join(root, '.webcodex');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'file-symlink-tests.log'), stdout + stderr);
await writeFile(path.join(directory, 'file-symlink-tests.json'), JSON.stringify(report, null, 2) + '\n');
if (!passed) process.stderr.write('Strict file-symlink checks did not pass. Inspect .webcodex/file-symlink-tests.log. On Windows, use a terminal with file-symlink privileges (for example an administrator PowerShell), or an environment with Developer Mode already enabled. No system setting was changed.\n');
process.exitCode = passed ? 0 : 1;
