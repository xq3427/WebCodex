import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// tsc does not remove outputs of deleted/archived sources. Select the current
// source inventory so an old dist/test artifact cannot re-enable an experiment.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = (await readdir(path.join(root, 'test'), { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map(entry => path.join(root, 'dist', 'test', entry.name.replace(/\.ts$/, '.js'))).sort();
if (!files.length) throw new Error('No current test sources were found.');
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: root, shell: false, windowsHide: true, stdio: 'inherit' });
child.once('error', () => { process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
