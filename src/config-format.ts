import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import path from 'node:path';
import { AppError } from './errors.js';

export type ConfigFormat = 'json' | 'toml';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const fail = () => new AppError('CONFIG_ERROR', 'Configuration syntax, duplicate keys or reserved property names are invalid. No configuration contents are included in this diagnostic.');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function configFormatForPath(file: string): ConfigFormat {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.toml') return 'toml';
  if (extension === '.json') return 'json';
  throw new AppError('CONFIG_ERROR', 'Configuration must use a .toml or .json filename.');
}

export function assertSafeConfigObject(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(assertSafeConfigObject); return; }
  if (!object(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw fail();
    assertSafeConfigObject(child);
  }
}

/** JSON.parse alone silently discards duplicate fields; scan keys before constructing the object. */
function verifyJsonKeys(text: string) {
  let at = 0;
  const space = () => { while (/[\t\r\n ]/.test(text[at] ?? '\0')) at++; };
  const string = () => {
    const start = at++;
    if (text[start] !== '"') throw fail();
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at++] === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw fail();
  };
  const value = (): void => {
    space();
    if (text[at] === '"') { string(); return; }
    if (text[at] === '{') {
      at++; space(); const keys = new Set<string>();
      if (text[at] === '}') { at++; return; }
      while (true) {
        space(); const key = string();
        if (keys.has(key) || forbidden.has(key)) throw fail();
        keys.add(key); space(); if (text[at++] !== ':') throw fail(); value(); space();
        const end = text[at++]; if (end === '}') return; if (end !== ',') throw fail();
      }
    }
    if (text[at] === '[') {
      at++; space(); if (text[at] === ']') { at++; return; }
      while (true) { value(); space(); const end = text[at++]; if (end === ']') return; if (end !== ',') throw fail(); }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!token) throw fail(); at += token[0].length;
  };
  value(); space(); if (at !== text.length) throw fail();
}

export function parseConfigText(text: string, format: ConfigFormat): unknown {
  try {
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw fail();
    const clean = text.replace(/^\uFEFF/, '');
    if (format === 'json') verifyJsonKeys(clean);
    const parsed: unknown = format === 'json' ? JSON.parse(clean) : parseToml(clean);
    assertSafeConfigObject(parsed);
    return parsed;
  } catch { throw fail(); }
}

function tomlObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => { if (item === null || item === undefined) throw fail(); return tomlObject(item); });
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => [key, tomlObject(item)]));
  return value;
}
const identity = (value: unknown): string | undefined => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const keyPath = (parts: Array<string | number>) => JSON.stringify(parts);
const key = (value: string) => /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
function literal(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value).replace(/\u0008/g, '\\b').replace(/\u000c/g, '\\f');
  if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return '[' + value.map(literal).join(', ') + ']';
  if (object(value)) return '{ ' + Object.entries(value).map(([name, child]) => key(name) + ' = ' + literal(child)).join(', ') + ' }';
  throw fail();
}

type Location = { start: number; end: number; valueStart: number; valueEnd: number; comment: string; innerComments: string[] };
type Section = { start: number; body: number; end: number; path: Array<string | number> };
/** Conservatively edit ordinary tables and workspace array tables. Unsupported source layouts fail closed. */
function editToml(original: string, next: unknown): string {
  const previous = tomlObject(parseConfigText(original, 'toml'));
  const target = tomlObject(next);
  if (identity(previous) === identity(target)) return original;
  const unsupported = () => new AppError('CONFIG_EDIT_UNSUPPORTED', 'This TOML layout cannot be safely edited while preserving comments. Edit the selected file locally; no changes were saved.');
  const locations = new Map<string, Location>();
  const sections = new Map<string, Section>();
  const commentLines = new Map<number, string>();
  const arrays = new Map<string, number>();
  let section: Section = { start: 0, body: 0, end: original.length, path: [] };
  sections.set('[]', section);
  let offset = 0;
  const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    let line = lines[lineIndex];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { if (trimmed.startsWith('#')) commentLines.set(offset, line.replace(/\r?\n$/, '')); offset += line.length; continue; }
    // These local edit forms deliberately exclude quoted/dotted table keys with exotic syntax.
    const header = /^\s*(\[\[?)([A-Za-z0-9_.-]+)(\]\]?)\s*(#.*)?(?:\r?\n)?$/.exec(line);
    if (header) {
      if (header[1].length !== header[3].length) throw unsupported();
      if (header[4]) commentLines.set(offset, header[4].trimEnd());
      // TOML subtable headers always refer to the most recent enclosing array
      // element. Include that element in every nested section's semantic path.
      const names = header[2].split('.');
      const parts: Array<string | number> = [];
      for (const [index, name] of names.entries()) {
        parts.push(name);
        const arrayPath = keyPath(parts);
        if (header[1] === '[[' && index === names.length - 1) {
          const nextIndex = arrays.get(arrayPath) ?? 0;
          arrays.set(arrayPath, nextIndex + 1);
          parts.push(nextIndex);
        } else if (arrays.has(arrayPath)) parts.push(arrays.get(arrayPath)! - 1);
      }
      section.end = offset;
      section = { start: offset, body: offset + line.length, end: original.length, path: parts };
      sections.set(keyPath(parts), section);
      offset += line.length; continue;
    }
    const assignment = /^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)/.exec(line);
    if (!assignment) throw unsupported();
    const workspaceArray = section.path.length === 0 && assignment[2] === 'workspaces' && line.slice(assignment[0].length).startsWith('[');
    const innerComments: string[] = [];
    let quote = '', escaped = false, depth = 0, commentAt = -1;
    for (let i = assignment[0].length; i < line.length; i++) {
      const c = line[i];
      if (escaped) { escaped = false; continue; }
      if (quote) { if (quote === '"' && c === '\\') escaped = true; else if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { if (line.slice(i, i + 3) === c.repeat(3)) throw unsupported(); quote = c; }
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === '#') {
        const newline = line.indexOf('\n', i);
        const end = newline < 0 ? line.length : newline;
        const comment = line.slice(i, end).trimEnd();
        if (depth === 0) { commentAt = i; break; }
        if (!workspaceArray) throw unsupported();
        innerComments.push(comment); commentLines.set(offset + i, comment);
        i = end - 1;
      }
      if (i === line.length - 1 && depth > 0 && workspaceArray) {
        if (quote || ++lineIndex >= lines.length) throw unsupported();
        line += lines[lineIndex];
      }
    }
    if (quote || depth !== 0) throw unsupported();
    const beforeComment = commentAt < 0 ? line.replace(/\r?\n$/, '') : line.slice(0, commentAt);
    const end = beforeComment.trimEnd().length;
    locations.set(keyPath([...section.path, ...assignment[2].split('.')]), { start: offset, end: offset + line.length, valueStart: offset + assignment[0].length, valueEnd: offset + end, comment: commentAt < 0 ? '' : line.slice(commentAt).trimEnd(), innerComments });
    if (commentAt >= 0) commentLines.set(offset, line.slice(commentAt).trimEnd());
    offset += line.length;
  }
  const changes: Array<{ start: number; end: number; text: string }> = [];
  const additions = new Map<string, { path: Array<string | number>; values: Record<string, unknown> }>();
  const commentsOnly = (start: number, end: number) => [...commentLines].filter(([at]) => at >= start && at < end).map(([, comment]) => comment).join('\n') + '\n';
  const descendant = (parent: Array<string | number>, child: Array<string | number>) => child.length >= parent.length && parent.every((part, index) => part === child[index]);
  const removeSubtree = (parts: Array<string | number>) => {
    const removedSections = [...sections.values()].filter(item => descendant(parts, item.path));
    for (const item of removedSections) changes.push({ start: item.start, end: item.end, text: commentsOnly(item.start, item.end) });
    // Dotted assignments can define the removed object in an enclosing section.
    const removedLocations = [...locations].filter(([id, item]) => descendant(parts, JSON.parse(id)) && !removedSections.some(section => item.start >= section.start && item.end <= section.end));
    for (const [, item] of removedLocations) changes.push({ start: item.start, end: item.end, text: item.comment ? item.comment + '\n' : '' });
    if (!removedSections.length && !removedLocations.length) throw unsupported();
  };
  const change = (parts: Array<string | number>, before: unknown, after: unknown): void => {
    if (identity(before) === identity(after)) return;
    const location = locations.get(keyPath(parts));
    if (location) {
      // Updating a multiline path array keeps its comments beside the assignment.
      // Unchanged arrays retain their exact layout; rewritten arrays use inline literals.
      if (location.innerComments.length) changes.push({ start: location.start, end: location.start, text: location.innerComments.join('\n') + '\n' });
      changes.push(after === undefined ? { start: location.start, end: location.end, text: location.comment ? location.comment + '\n' : '' } : { start: location.valueStart, end: location.valueEnd, text: literal(after) });
      return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length === after.length) { before.forEach((item, index) => change([...parts, index], item, after[index])); return; }
      if (after.length > before.length && before.every((item, index) => identity(item) === identity(after[index]))) {
        if (parts.length !== 1 || typeof parts[0] !== 'string') throw unsupported();
        changes.push({ start: original.length, end: original.length, text: '\n' + stringifyToml({ [parts[0]]: after.slice(before.length) } as any) }); return;
      }
      let nextIndex = 0;
      for (let index = 0; index < before.length; index++) {
        if (nextIndex < after.length && identity(before[index]) === identity(after[nextIndex])) { nextIndex++; continue; }
        removeSubtree([...parts, index]);
      }
      if (nextIndex !== after.length) throw unsupported();
      return;
    }
    if (object(before) && after === undefined) {
      removeSubtree(parts); return;
    }
    if (object(after)) {
      const prior = object(before) ? before : {};
      for (const name of new Set([...Object.keys(prior), ...Object.keys(after)])) change([...parts, name], prior[name], after[name]);
      return;
    }
    if (before !== undefined || after === undefined || typeof parts.at(-1) !== 'string') throw unsupported();
    const parent = parts.slice(0, -1); const id = keyPath(parent);
    const group = additions.get(id) ?? { path: parent, values: {} };
    group.values[String(parts.at(-1))] = after; additions.set(id, group);
  };
  change([], previous, target);
  for (const group of additions.values()) {
    const existing = sections.get(keyPath(group.path));
    const text = Object.entries(group.values).map(([name, value]) => `${key(name)} = ${literal(value)}\n`).join('');
    if (existing) changes.push({ start: existing.end, end: existing.end, text: '\n' + text });
    else {
      if (group.path.some(part => typeof part === 'number')) {
        // A header appended at EOF would bind to the last workspace instead of
        // this one. Insert dotted fields in its nearest existing ancestor body.
        const ancestor = [...sections.values()].filter(item => descendant(item.path, group.path) && group.path.slice(item.path.length).every(part => typeof part === 'string')).sort((a, b) => b.path.length - a.path.length)[0];
        if (!ancestor) throw unsupported();
        const prefix = group.path.slice(ancestor.path.length).map(part => key(String(part)));
        const dotted = Object.entries(group.values).map(([name, value]) => `${[...prefix, key(name)].join('.')} = ${literal(value)}\n`).join('');
        changes.push({ start: ancestor.end, end: ancestor.end, text: '\n' + dotted });
      } else changes.push({ start: original.length, end: original.length, text: '\n[' + group.path.map(part => key(String(part))).join('.') + ']\n' + text });
    }
  }
  let output = original;
  for (const item of changes.sort((a, b) => b.start - a.start || b.end - a.end)) output = output.slice(0, item.start) + item.text + output.slice(item.end);
  try { if (identity(parseConfigText(output, 'toml')) !== identity(target)) throw unsupported(); }
  catch { throw unsupported(); }
  return output;
}

export function serializeConfig(value: unknown, format: ConfigFormat, options: { originalText?: string } = {}): string {
  assertSafeConfigObject(value);
  if (format === 'json') {
    try { return JSON.stringify(value, null, 2) + '\n'; }
    catch { throw new AppError('CONFIG_ERROR', 'Configuration cannot be represented as JSON.'); }
  }
  if (options.originalText !== undefined) return editToml(options.originalText, value);
  try { return stringifyToml(tomlObject(value) as any); }
  catch { throw new AppError('CONFIG_ERROR', 'Configuration cannot be represented as TOML.'); }
}
