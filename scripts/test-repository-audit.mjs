import assert from 'node:assert/strict';
import test from 'node:test';
import { forbiddenPath, localLinks, scanText } from './audit-repository.mjs';

test('flags credential-like material but never returns the matched bytes', () => {
  const credential = 'sk-' + 'x'.repeat(40);
  const key = '-----BEGIN ' + 'PRIVATE KEY-----';
  const findings = scanText('examples/example.txt', 'first\n' + credential + '\n' + key);
  assert.deepEqual(findings.map(f => [f.rule, f.line]), [['credential-token', 2], ['private-key', 3]]);
  assert.ok(!JSON.stringify(findings).includes(credential));
  assert.ok(!JSON.stringify(findings).includes(key));
});

test('runtime and credentials are forbidden even when force-added to Git', () => {
  for (const file of ['.webcodex/state/db.sqlite', 'config.json', 'config.toml', '.env.production',
    'my.local.toml', 'private.pem', 'dist/src/cli.js', 'research/notes.md', 'experiments/draft.ts'])
    assert.equal(forbiddenPath(file), true, file);
  for (const file of ['examples/config.example.toml', 'examples/config.example.json',
    '.env.example', '.github/workflows/ci.yml', 'test/config.test.ts']) assert.equal(forbiddenPath(file), false, file);
});

test('local documentation links must exist and cannot expose private archives', () => {
  assert.equal(localLinks('README.md', '[docs](docs/README.md) [web](https://example.com) [a](#anchor)').length, 0);
  assert.equal(localLinks('README.md', '[missing](docs/missing-guide.md)').length, 1);
  assert.equal(localLinks('README.md', '[private](.webcodex/config.toml)').length, 1);
  assert.equal(localLinks('README.md', '[escape](../../outside.md)').length, 1);
});

test('synthetic fixture exemption is narrow and does not suppress other keys', () => {
  const synthetic = ['sk', 'synthetic-unified-config-never-output-123456'].join('-');
  assert.equal(scanText('test/unified-integration.test.ts', synthetic).length, 0);
  assert.equal(scanText('README.md', synthetic).length, 1);
  assert.equal(scanText('test/unified-integration.test.ts', 'sk-' + 'y'.repeat(40)).length, 1);
});
