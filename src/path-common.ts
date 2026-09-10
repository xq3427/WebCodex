import path from 'node:path';

const protectedNames = new Set(['.webcodex','.git','.ssh','.codex','.agents','.aws','.azure','.gnupg','.kube','.docker','.npmrc','.pypirc','.netrc']);
// Filename protection covers common local credential files, not arbitrary secrets in source code.
const credentialName = /^(?:(?:api[-_]?keys?|access[-_]?tokens?|auth[-_]?tokens?|credentials?|secrets?|private[-_]?keys?)(?:\.(?:txt|json|ya?ml|toml|key|pem))?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.(?:pem|key))?)$/i;
export function isProtectedName(name: string): boolean {
  return protectedNames.has(name.toLowerCase()) || credentialName.test(name) || /^\.env(?:\.|$)/i.test(name) || /^\.webcodex-write-/i.test(name);
}
export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
