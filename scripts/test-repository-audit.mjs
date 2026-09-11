import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { forbiddenPath, isReviewedSyntheticPdf, localLinks, scanText } from './audit-repository.mjs';

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

test('test files cannot bypass personal path or tunnel identity checks', () => {
  const personalPath = ['C:', 'Users', 'private-user', 'project'].join('\\');
  const tunnel = 'tunnel_' + 'a'.repeat(32);
  const network = 'https://' + ['172', '20', '40', '80'].join('.');
  const findings = scanText('test/example.test.ts', [personalPath, tunnel, network].join('\n'));
  assert.deepEqual(findings.map(({ rule, line }) => [rule, line]).sort(), [
    ['personal-windows-path', 1], ['live-tunnel-identity', 2], ['private-network-endpoint', 3],
  ].sort());
  assert.ok(!JSON.stringify(findings).includes(personalPath));
  assert.ok(!JSON.stringify(findings).includes(tunnel));
  for (const user of ['example', 'Public', 'Default'])
    assert.equal(scanText('test/example.test.ts', ['C:', 'Users', user, 'project'].join('\\')).length, 0);
});

test('binary exemption accepts only the reviewed synthetic PDF bytes', () => {
  const reviewed = readFileSync(new URL('../test/fixtures/webcodex-reading-check.pdf', import.meta.url));
  assert.equal(isReviewedSyntheticPdf(reviewed), true);
  assert.equal(isReviewedSyntheticPdf(Buffer.from('%PDF-1.7\nreplacement')), false);
  const changed = Buffer.from(reviewed);
  changed[changed.length - 1] ^= 1;
  assert.equal(isReviewedSyntheticPdf(changed), false);
  assert.equal(isReviewedSyntheticPdf(Buffer.concat([reviewed, Buffer.from('\nextra content')])), false);
});
