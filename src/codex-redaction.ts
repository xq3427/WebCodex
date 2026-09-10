const REDACTED = '[REDACTED]';
type Span = { start: number; end: number };

const sensitiveField = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|auth[_-]?token|secret[_-]?key)$/i;
const sensitiveQuery = /^(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|auth[_-]?token)$/i;

function placeholder(value: string): boolean {
  return value === REDACTED || value.length === 0 || /^(?:null|undefined|true|false)$/i.test(value)
    || /^(?:\$\{[A-Za-z_][\w:.-]*\}|\$(?:env:)?[A-Za-z_][\w]*|<[A-Za-z_][\w -]*>)$/.test(value);
}

/** Read a shell/JSON value without interpreting or evaluating its contents. */
function valueAt(text: string, offset: number): Span & { next: number } {
  const reference = /^(?:\[REDACTED\]|\$\{[A-Za-z_][\w:.-]*\}|\$(?:env:)?[A-Za-z_][\w]*|<[A-Za-z_][\w -]*>)/.exec(text.slice(offset));
  if (reference) return { start: offset, end: offset + reference[0].length, next: offset + reference[0].length };

  const escapedQuote = text[offset] === '\\' && (text[offset + 1] === '"' || text[offset + 1] === "'");
  const quote = escapedQuote ? text[offset + 1] : text[offset];
  if (quote === '"' || quote === "'") {
    const start = offset + (escapedQuote ? 2 : 1);
    let position = start;
    while (position < text.length) {
      if (escapedQuote && text[position] === '\\') {
        const runStart = position;
        while (text[position] === '\\') position++;
        const slashes = position - runStart;
        if (text[position] === quote && slashes === 1) return { start, end: runStart, next: position + 1 };
        // A quote escaped inside a JSON-encoded string has three backslashes.
        if (text[position] === quote && slashes % 2 === 1) position++;
        continue;
      }
      if (!escapedQuote && (text[position] === '\\' || text[position] === '`')) {
        position = Math.min(text.length, position + 2);
        continue;
      }
      if (!escapedQuote && text[position] === quote) {
        if (quote === "'" && text[position + 1] === "'") { position += 2; continue; }
        return { start, end: position, next: position + 1 };
      }
      position++;
    }
    // An incomplete quoted credential is still sensitive through the end.
    return { start, end: text.length, next: text.length };
  }
  let end = offset;
  while (end < text.length && !/[\s,;&}\])"'#]/.test(text[end])) {
    if ((text[end] === '\\' || text[end] === '`') && end + 1 < text.length) end += 2;
    else end++;
  }
  return { start: offset, end, next: end };
}

/**
 * Redact recognized credential forms in a COMPLETE visible session field.
 * Call before truncation or pagination; a partial token can evade format rules.
 * This is a deterministic best-effort filter, not a detector for every secret.
 * It performs no logging, network access, decoding of JWT payloads, or evaluation.
 */
export function redactSessionText(text: string): { text: string; redactions: number } {
  const spans: Span[] = [];
  const add = (start: number, end: number) => {
    if (end > start && !placeholder(text.slice(start, end))) spans.push({ start, end });
  };
  const collect = (pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) add(match.index, match.index + match[0].length);
  };

  // Match complete blocks; an unfinished private-key block is hidden to EOF.
  const pem = /-----BEGIN ((?:[A-Z0-9]+ )?PRIVATE KEY)-----/g;
  for (let match = pem.exec(text); match; match = pem.exec(text)) {
    const ending = `-----END ${match[1]}-----`;
    const endingAt = text.indexOf(ending, pem.lastIndex);
    const end = endingAt < 0 ? text.length : endingAt + ending.length;
    add(match.index, end);
    pem.lastIndex = end;
  }

  collect(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g);
  collect(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g);
  collect(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g);

  // These flat, bounded identifier matches avoid recursive parsing/backtracking.
  const assignments = /(?<![A-Za-z0-9_-])(?:\\?["'])?([A-Za-z_][A-Za-z0-9_-]{0,127})(?:\\?["'])?[ \t]*[:=]\s*/g;
  for (let match = assignments.exec(text); match; match = assignments.exec(text)) {
    const name = match[1];
    if (!sensitiveField.test(name) && !/^(?:proxy[_-]?)?authorization$/i.test(name)) continue;
    const value = valueAt(text, assignments.lastIndex);
    if (/^(?:proxy[_-]?)?authorization$/i.test(name)) {
      const bearer = /^Bearer[ \t]+/i.exec(text.slice(value.start, value.end));
      if (bearer) add(value.start + bearer[0].length, value.end);
      else if (/^Bearer[ \t]+/i.test(text.slice(assignments.lastIndex))) {
        // Unquoted HTTP headers: the first whitespace terminates valueAt.
        const prefix = /^Bearer[ \t]+/i.exec(text.slice(assignments.lastIndex))!;
        const token = valueAt(text, assignments.lastIndex + prefix[0].length);
        add(token.start, token.end);
        assignments.lastIndex = Math.max(assignments.lastIndex, token.next);
      }
    } else {
      add(value.start, value.end);
    }
    assignments.lastIndex = Math.max(assignments.lastIndex, value.next);
  }

  for (const url of text.matchAll(/\b[A-Za-z][A-Za-z0-9+.-]{0,15}:\/\/[^\s<>"'`]+/g)) {
    const authorityStart = url[0].indexOf('://') + 3;
    const authority = url[0].slice(authorityStart).split(/[/?#]/, 1)[0];
    const at = authority.lastIndexOf('@');
    if (at >= 0) add(url.index + authorityStart, url.index + authorityStart + at);
    for (const query of url[0].matchAll(/[?&]([^=&#]{1,100})=([^&#]*)/g)) {
      let name: string;
      try { name = decodeURIComponent(query[1].replace(/^amp;/, '')); } catch { continue; }
      if (!sensitiveQuery.test(name)) continue;
      const start = url.index + query.index + query[0].indexOf('=') + 1;
      add(start, start + query[2].length);
    }
  }

  // Overlapping rules (e.g. api_key="sk-...") redact and count only once.
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  if (merged.length === 0) return { text, redactions: 0 };
  const parts: string[] = [];
  let cursor = 0;
  for (const span of merged) {
    parts.push(text.slice(cursor, span.start), REDACTED);
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(''), redactions: merged.length };
}
