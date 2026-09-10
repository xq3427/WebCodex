import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const decoder = new TextDecoder('utf-8', { fatal: true });
const forbidden = /(^|\/)(?:\.webcodex|\.codex|\.agents|node_modules|dist|research|experiments|coverage)(\/|$)|(^|\/)(?:config\.(?:json|toml)|\.env(?:\..*)?|API_key\.txt|api[-_]?key\.txt|credentials\.json|secrets\.json|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519)$|\.(?:local\.(?:json|toml)|log|pem|key|pfx|p12|sqlite(?:-.+)?|db(?:-.+)?)$/i;

export function scanText(file, text) {
  const findings = [];
  const rules = [
    ['credential-token', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/g],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
    ['personal-windows-path', /[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|example\b)[^\s"'\x60/\\]+/gi],
    ['private-network-endpoint', /(?:https?:\/\/|@)172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}/g],
  ];
  for (const [rule, regex] of rules) {
    // Test source intentionally exercises platform path syntax and synthetic private networks.
    if (file.startsWith('test/') && ['personal-windows-path', 'private-network-endpoint'].includes(rule)) continue;
    for (const match of text.matchAll(regex)) {
      if (file === 'test/unified-integration.test.ts' && rule === 'credential-token' &&
          match[0] === ['sk', 'synthetic-unified-config-never-output-123456'].join('-')) continue;
      findings.push({ file, line: text.slice(0, match.index).split('\n').length, rule });
    }
  }
  return findings;
}

export function forbiddenPath(file) {
  return forbidden.test(file) && file !== '.env.example';
}

export function localLinks(file, text) {
  const findings = [];
  const prose = text.replace(/^(?:\x60{3}|~~~)[\s\S]*?^(?:\x60{3}|~~~)[^\n]*$/gm, '');
  for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)) {
    const raw = match[1].replace(/^<|>$/g, '').trim();
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(raw)) continue;
    let target;
    try { target = decodeURIComponent(raw.split('#')[0]); }
    catch { findings.push({ file, rule: 'invalid-local-link' }); continue; }
    if (!target) continue;
    const resolved = path.resolve(root, path.dirname(file), target);
    const relative = path.relative(root, resolved).replaceAll(path.sep, '/');
    if (relative.startsWith('../') || path.isAbsolute(relative) || forbiddenPath(relative) || !existsSync(resolved))
      findings.push({ file, rule: 'missing-or-private-local-link' });
  }
  return findings;
}

export function auditRepository() {
  // Include tracked ignored files too; never open ignored untracked credentials or runtime data.
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const files = [...new Set(listed.split('\0').filter(Boolean))].sort();
  const findings = [];
  for (const file of files) {
    if (forbiddenPath(file)) { findings.push({ file, rule: 'private-or-generated-file' }); continue; }
    const full = path.resolve(root, file);
    const relative = path.relative(root, full);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { findings.push({ file, rule: 'outside-repository' }); continue; }
    if (!existsSync(full)) { findings.push({ file, rule: 'missing-candidate' }); continue; }
    const info = lstatSync(full);
    if (!info.isFile() || info.isSymbolicLink()) { findings.push({ file, rule: 'not-ordinary-file' }); continue; }
    if (info.size > 1024 * 1024) { findings.push({ file, rule: 'large-file-review-required' }); continue; }
    const bytes = readFileSync(full);
    if (file === 'test/fixtures/webcodex-reading-check.pdf') {
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) findings.push({ file, rule: 'invalid-synthetic-pdf' });
      continue;
    }
    let text;
    try { text = decoder.decode(bytes); if (text.includes('\0')) throw new Error(); }
    catch { findings.push({ file, rule: 'binary-file-review-required' }); continue; }
    findings.push(...scanText(file, text));
    if (file.endsWith('.md')) findings.push(...localLinks(file, text));
  }
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const source = readFileSync(path.join(root, 'src/version.ts'), 'utf8');
  const tools = JSON.parse(readFileSync(path.join(root, 'docs/tools.json'), 'utf8'));
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version ||
      !source.includes("'" + pkg.version + "'") || tools.server.version !== pkg.version)
    findings.push({ file: 'package.json', rule: 'version-drift' });
  if (pkg.license !== 'MIT' || lock.packages[''].license !== 'MIT' || !existsSync(path.join(root, 'LICENSE')))
    findings.push({ file: 'LICENSE', rule: 'license-metadata-missing' });
  if (pkg.dependencies?.['playwright-core'] || pkg.dependencies?.playwright ||
      tools.tools.some(tool => tool.name.startsWith('attachment_')))
    findings.push({ file: 'package.json', rule: 'deferred-feature-in-mainline' });
  return { files, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditRepository();
  // Only locations/rule names, never offending source lines or matched credential strings.
  for (const finding of result.findings) process.stderr.write(JSON.stringify(finding) + '\n');
  console.log(JSON.stringify({ ok: !result.findings.length, candidate_files: result.files.length,
    findings: result.findings.length, scope: 'Git tracked and non-ignored untracked files; ignored local data was not scanned' }));
  process.exitCode = result.findings.length ? 1 : 0;
}
