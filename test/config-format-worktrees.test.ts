import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigText, serializeConfig } from '../src/config-format.js';

type Document = { workspaces: Array<{ id: string; root: string; worktree?: { gitDir: string; commonDir: string } }>; tunnel: { apiKey: string } };
const source = `# configuration note
[[workspaces]] # first workspace
id = "first"
root = "first-checkout"
[workspaces.worktree] # first metadata
gitDir = "repo/.git/worktrees/first" # first gitdir
commonDir = "repo/.git"

[tunnel] # unrelated section
apiKey = "synthetic-private-key" # keep local key

[[workspaces]] # second workspace
id = "second"
root = "second-checkout"
[workspaces.worktree] # second metadata
gitDir = "repo/.git/worktrees/second" # second gitdir
commonDir = "repo/.git"
`;
const parse = (text: string) => parseConfigText(text, 'toml') as Document;
const edit = (original: string, change: (document: Document) => void) => {
  const document = parse(original);
  change(document);
  const output = serializeConfig(document, 'toml', { originalText: original });
  assert.deepEqual(parse(output), document);
  return output;
};

test('nested workspace tables edit the current array element without touching siblings or secrets', () => {
  const output = edit(source, document => {
    document.workspaces[0].root = 'replacement-checkout';
    document.workspaces[0].worktree = { gitDir: 'other/.git/worktrees/replacement', commonDir: 'other/.git' };
  });
  assert.match(output, /gitDir = "other\/\.git\/worktrees\/replacement" # first gitdir/);
  assert.match(output, /gitDir = "repo\/\.git\/worktrees\/second" # second gitdir/);
  assert.ok(output.includes('[tunnel] # unrelated section\napiKey = "synthetic-private-key" # keep local key'));
  assert.equal(serializeConfig(parse(output), 'toml', { originalText: output }), output);
});

test('removing a workspace deletes its nested table and preserves comments and unrelated sections', () => {
  const output = edit(source, document => { document.workspaces.splice(0, 1); });
  assert.deepEqual(parse(output).workspaces.map(workspace => workspace.id), ['second']);
  assert.equal((output.match(/\[workspaces\.worktree\]/g) ?? []).length, 1);
  for (const comment of ['# configuration note', '# first workspace', '# first metadata', '# first gitdir', '# second metadata', '# unrelated section', '# keep local key']) assert.ok(output.includes(comment));
  assert.ok(output.includes('[tunnel] # unrelated section\napiKey = "synthetic-private-key" # keep local key'));
});

test('removing only worktree authorization preserves the workspace and the other array element', () => {
  const output = edit(source, document => { delete document.workspaces[0].worktree; });
  assert.equal(parse(output).workspaces[0].worktree, undefined);
  assert.equal(parse(output).workspaces[1].worktree?.gitDir, 'repo/.git/worktrees/second');
  assert.ok(output.includes('# first metadata'));
  assert.ok(output.includes('# first gitdir'));
});

test('ordinary workspace can become a worktree before another workspace without binding its metadata to the last element', () => {
  const ordinary = edit(source, document => { delete document.workspaces[0].worktree; });
  const output = edit(ordinary, document => { document.workspaces[0].worktree = { gitDir: 'new/.git/worktrees/new', commonDir: 'new/.git' }; });
  assert.match(output, /worktree\.gitDir = "new\/\.git\/worktrees\/new"/);
  const rebound = edit(output, document => { document.workspaces[0].worktree!.gitDir = 'new/.git/worktrees/rebound'; });
  assert.equal(parse(rebound).workspaces[0].worktree?.gitDir, 'new/.git/worktrees/rebound');
  const removed = edit(rebound, document => { delete document.workspaces[0].worktree; });
  assert.equal(parse(removed).workspaces[0].worktree, undefined);
  assert.equal(parse(removed).workspaces[1].worktree?.gitDir, 'repo/.git/worktrees/second');
});

test('workspace removal covers distant child sections without deleting intervening tables', () => {
  const interleaved = `[[workspaces]] # first
id = "first"
root = "first"
[tunnel]
apiKey = "synthetic-private-key"
[workspaces.worktree] # deferred child
gitDir = "repo/.git/worktrees/first"
commonDir = "repo/.git"
[[workspaces]] # survivor
id = "second"
root = "second"
`;
  const output = edit(interleaved, document => { document.workspaces.splice(0, 1); });
  assert.equal(parse(output).tunnel.apiKey, 'synthetic-private-key');
  assert.ok(output.includes('# deferred child'));
  assert.ok(output.includes('# survivor'));
});

test('nested arrays resolve each parent index and remove complete nested subtrees', () => {
  const nested = `[[workspaces]]
id = "one"
[[workspaces.groups]]
id = "group1"
[workspaces.groups.options]
flag = true # options note
[[workspaces]]
id = "two"
[[workspaces.groups]]
id = "group2"
[workspaces.groups.options]
flag = false
`;
  const document = parseConfigText(nested, 'toml') as { workspaces: Array<{ id: string; groups: Array<{ id: string; options: { flag: boolean } }> }> };
  document.workspaces[0].groups[0].options.flag = false;
  const changed = serializeConfig(document, 'toml', { originalText: nested });
  assert.deepEqual(parseConfigText(changed, 'toml'), document);
  document.workspaces.splice(0, 1);
  const removed = serializeConfig(document, 'toml', { originalText: changed });
  assert.deepEqual(parseConfigText(removed, 'toml'), document);
  assert.ok(removed.includes('# options note'));
});

test('unsupported quoted headers still fail closed without exposing configuration text', () => {
  const quoted = '[["workspaces"]]\nid = "one"\nroot = "one"\n[tunnel]\napiKey = "synthetic-private-key"\n';
  const document = parse(quoted);
  document.workspaces[0].root = 'changed';
  assert.throws(() => serializeConfig(document, 'toml', { originalText: quoted }), error => {
    assert.equal((error as { code: string }).code, 'CONFIG_EDIT_UNSUPPORTED');
    assert.doesNotMatch(String(error) + JSON.stringify(error), /synthetic-private-key/);
    return true;
  });
});
