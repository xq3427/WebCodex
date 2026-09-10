import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSessionText } from '../src/codex-redaction.js';

test('redacts recognizable OpenAI, GitHub and JWT credentials without exposing their values', () => {
  const secrets = [
    'sk-' + 'a'.repeat(40), 'sk-proj-' + 'b'.repeat(70), 'sk-svcacct-' + 'c'.repeat(40),
    'ghp_' + 'd'.repeat(36), 'gho_' + 'e'.repeat(36), 'ghu_' + 'f'.repeat(36),
    'ghs_' + 'g'.repeat(36), 'ghr_' + 'h'.repeat(36), 'github_pat_' + 'i'.repeat(60),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGljc2lnbmF0dXJl',
  ];
  const result = redactSessionText('合成凭据：\n' + secrets.join('\n'));
  assert.equal(result.redactions, secrets.length);
  assert.equal(result.text, '合成凭据：\n' + secrets.map(() => '[REDACTED]').join('\n'));
  for (const secret of secrets) assert.ok(!result.text.includes(secret));
});

test('redacts JSON, environment, shell and escaped quoted assignments while preserving formatting', () => {
  const cases: Array<[string, string]> = [
    ['{"api_key":"synthetic-value","name":"中文项目"}', '{"api_key":"[REDACTED]","name":"中文项目"}'],
    ['export OPENAI_API_KEY=synthetic-value # 配置', 'export OPENAI_API_KEY=[REDACTED] # 配置'],
    ['$env:OPENAI_API_KEY = "synthetic-value"', '$env:OPENAI_API_KEY = "[REDACTED]"'],
    ["password='synthetic short'", "password='[REDACTED]'"],
    [String.raw`{"client_secret":"synthetic\"quoted","ok":true}`, '{"client_secret":"[REDACTED]","ok":true}'],
    [String.raw`{\"api_key\":\"synthetic\\\"quoted\",\"ok\":true}`, String.raw`{\"api_key\":\"[REDACTED]\",\"ok\":true}`],
    ["password='synthetic''quoted'", "password='[REDACTED]'"],
    ['password="synthetic`"quoted"', 'password="[REDACTED]"'],
    [String.raw`API_KEY=synthetic\ space`, 'API_KEY=[REDACTED]'],
    ['{"refresh_token": "synthetic\\nvalue"}', '{"refresh_token": "[REDACTED]"}'],
    ['{"api_key":\n  "synthetic-value"\n}', '{"api_key":\n  "[REDACTED]"\n}'],
    ['accessToken="synthetic-value"', 'accessToken="[REDACTED]"'],
    ['PASSWORD=123', 'PASSWORD=[REDACTED]'],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(redactSessionText(input), { text: expected, redactions: 1 }, input);
  }
});

test('redacts bearer headers and URL credentials without removing safe parameters', () => {
  const cases: Array<[string, string, number]> = [
    ['Authorization: Bearer synthetic-value', 'Authorization: Bearer [REDACTED]', 1],
    ['{"Authorization":"Bearer synthetic-value"}', '{"Authorization":"Bearer [REDACTED]"}', 1],
    ["-H 'Authorization: Bearer synthetic-value'", "-H 'Authorization: Bearer [REDACTED]'", 1],
    ['https://user:synthetic@example.com/repo?q=hello', 'https://[REDACTED]@example.com/repo?q=hello', 1],
    ['https://example.com/api?token=synthetic&limit=10&api_key=another#section', 'https://example.com/api?token=[REDACTED]&limit=10&api_key=[REDACTED]#section', 2],
    ['https://example.com/api?api%5Fkey=synthetic%20value&page=2', 'https://example.com/api?api%5Fkey=[REDACTED]&page=2', 1],
    ['https://user:synthetic@example.com/api?access_token=second', 'https://[REDACTED]@example.com/api?access_token=[REDACTED]', 2],
  ];
  for (const [input, expected, count] of cases) assert.deepEqual(redactSessionText(input), { text: expected, redactions: count });
});

test('redacts multiline and incomplete PEM private keys, but preserves public keys', () => {
  for (const kind of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
    const input = `前言\r\n-----BEGIN ${kind}-----\r\nc3ludGhldGljLWZpeHR1cmU=\r\n-----END ${kind}-----\r\n后续`;
    assert.deepEqual(redactSessionText(input), { text: '前言\r\n[REDACTED]\r\n后续', redactions: 1 });
  }
  assert.deepEqual(redactSessionText('前言\n-----BEGIN ' + 'PRIVATE KEY-----\nunfinished'), { text: '前言\n[REDACTED]', redactions: 1 });
  const publicKey = '-----BEGIN PUBLIC KEY-----\nsynthetic-public-data\n-----END PUBLIC KEY-----';
  assert.deepEqual(redactSessionText(publicKey), { text: publicKey, redactions: 0 });
});

test('preserves project text, paths, identifiers, short token examples and variable references', () => {
  const input = [
    '项目 WebCodex：读取 D:/Projects/demo\\src\\app.ts，再运行 npm test。',
    'const passwordLength = 12; const api_key_file = "config.json";',
    'API_KEY=$OPENAI_API_KEY', '$env:API_KEY=$env:OPENAI_API_KEY', 'API_KEY=${OPENAI_API_KEY}',
    'api_key=""; api_key=null; api_key="<your-api-key>"',
    'password=[REDACTED]', 'sk-example ghp_sample github_pat_demo v1.2.3',
    'See https://example.com/docs?topic=api_key&page=1',
  ].join('\n');
  assert.deepEqual(redactSessionText(input), { text: input, redactions: 0 });
});

test('merges overlapping matches, is idempotent, and redacts before truncation or pagination', () => {
  const secret = 'sk-proj-' + 'z'.repeat(80);
  const input = `中文标题 api_key="${secret}"\n后续内容`;
  const result = redactSessionText(input);
  assert.deepEqual(result, { text: '中文标题 api_key="[REDACTED]"\n后续内容', redactions: 1 });
  assert.deepEqual(redactSessionText(result.text), { text: result.text, redactions: 0 });
  // Consumers must redact the full field first, then apply their display bounds.
  const pages = Array.from({ length: Math.ceil(result.text.length / 7) }, (_, index) => result.text.slice(index * 7, index * 7 + 7));
  assert.equal(pages.join(''), result.text);
  assert.ok(!pages.join('').includes('sk-proj'));
  assert.ok(!result.text.slice(0, 24).includes('sk-proj'));
});

test('handles large ordinary text and quoted values with linear scanners', () => {
  const ordinary = '中文普通内容 ordinary_identifier '.repeat(10_000);
  assert.deepEqual(redactSessionText(ordinary), { text: ordinary, redactions: 0 });
  const input = 'password="' + String.raw`synthetic\"`.repeat(20_000) + '"';
  assert.deepEqual(redactSessionText(input), { text: 'password="[REDACTED]"', redactions: 1 });
});
