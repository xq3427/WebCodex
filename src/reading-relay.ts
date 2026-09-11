import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

export const READING_RELAY_CHALLENGE_PREFIX = 'webcodex-reading-relay-v1:';
export const READING_RELAY_TEXT_PREFIX = 'WebCodex browser relay: ';

export interface ReadingRelayOptions {
  ttlMs?: number;
  maxSessions?: number;
  maxTextBytes?: number;
  maxPendingReads?: number;
  now?: () => number;
}

/** ticket and challenge MUST be placed only in private component metadata. */
export interface ReadingRelayCreated {
  relay_id: string;
  expires_at: string;
  ticket: string;
  challenge: string;
}

export interface ReadingRelayReady {
  relay_id: string;
  status: 'ready';
  request_id: string;
  text: string;
  source: 'browser_component';
}

export type ReadingRelayResult = ReadingRelayReady | {
  relay_id: string;
  status: 'pending';
  retry_after_ms: 1000;
  pending_reads_remaining: number;
};

export type ReadingRelayPoll =
  | { status: 'complete' }
  | { status: 'pending'; request_id: string };

interface RelaySession {
  binding: string;
  ticketBytes: Buffer;
  expectedText: string;
  requestId: string;
  pendingReads: number;
  expiresAt: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  completed?: ReadingRelayReady;
}

function relayError(code: string, message: string): AppError {
  return new AppError(`RELAY_${code}`, message);
}

function boundedOption(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) {
    throw relayError('INVALID_ARGUMENT', 'Relay limits must be bounded positive integers.');
  }
  return result;
}

/**
 * Synthetic browser-to-model compatibility probe. No files or App state are read.
 * Own one instance per App/local service; optionally bind calls to a host session.
 * Preparation starts at creation. Every call returns immediately so a serialized
 * host can deliver component work between public model reads.
 */
export class ReadingRelayStore {
  private readonly sessions = new Map<string, RelaySession>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly maxTextBytes: number;
  private readonly maxPendingReads: number;
  private readonly now: () => number;
  private disposed = false;

  constructor(options: ReadingRelayOptions = {}) {
    this.ttlMs = boundedOption(options.ttlMs, 120_000, 600_000);
    this.maxSessions = boundedOption(options.maxSessions, 16, 128);
    this.maxTextBytes = boundedOption(options.maxTextBytes, 4_096, 65_536);
    this.maxPendingReads = boundedOption(options.maxPendingReads, 6, 6);
    this.now = options.now ?? Date.now;
  }

  create(binding = ''): ReadingRelayCreated {
    this.assertOpen();
    this.assertBinding(binding);
    this.prune();
    if (this.sessions.size >= this.maxSessions) {
      throw relayError('CAPACITY', 'Too many active relay probes. Close a probe or wait for it to expire.');
    }
    const relayId = randomUUID();
    const ticket = randomBytes(32).toString('base64url');
    const challenge = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    const session: RelaySession = {
      binding,
      ticketBytes: Buffer.from(ticket),
      expectedText: READING_RELAY_TEXT_PREFIX + createHash('sha256')
        .update(READING_RELAY_CHALLENGE_PREFIX + challenge, 'utf8').digest('hex'),
      requestId: randomUUID(),
      pendingReads: 0,
      expiresAt,
    };
    this.sessions.set(relayId, session);
    session.expiryTimer = setTimeout(() => this.expire(relayId, session), this.ttlMs);
    // A probe must not keep a stopped MCP process alive.
    session.expiryTimer.unref();
    return { relay_id: relayId, expires_at: new Date(expiresAt).toISOString(), ticket, challenge };
  }

  async read(relayId: string, options: { binding?: string; signal?: AbortSignal } = {}): Promise<ReadingRelayResult> {
    const session = this.get(relayId, options.binding ?? '');
    if (options.signal?.aborted) throw relayError('CANCELLED', 'The relay read was cancelled.');
    // A model retry after uncertain delivery must not require new component work,
    // and a prior pending-read quota must never hide already submitted content.
    if (session.completed) return { ...session.completed };
    if (session.pendingReads >= this.maxPendingReads) {
      throw relayError('READ_LIMIT', 'The pending-read limit was reached before component content arrived. Stop automatic retries and report this diagnostic; pending status is not successful reading.');
    }
    session.pendingReads++;
    return { relay_id: relayId, status: 'pending', retry_after_ms: 1000,
      pending_reads_remaining: this.maxPendingReads - session.pendingReads };
  }

  poll(relayId: string, ticket: string, binding = ''): ReadingRelayPoll {
    const session = this.authorize(relayId, ticket, binding);
    return session.completed ? { status: 'complete' } : { status: 'pending', request_id: session.requestId };
  }

  submit(relayId: string, ticket: string, requestId: string, text: string, binding = ''): { accepted: true; duplicate: boolean } {
    const session = this.authorize(relayId, ticket, binding);
    if (typeof text !== 'string' || text.length > this.maxTextBytes || Buffer.byteLength(text, 'utf8') > this.maxTextBytes) {
      throw relayError('PAYLOAD_TOO_LARGE', 'Relay content must fit the configured UTF-8 text budget.');
    }
    if (session.completed) {
      if (session.completed.request_id === requestId && session.completed.text === text) return { accepted: true, duplicate: true };
      throw relayError('STALE_SUBMISSION', 'This submission does not match the completed relay request.');
    }
    if (session.requestId !== requestId) {
      throw relayError('STALE_SUBMISSION', 'This submission does not match the prepared relay request.');
    }
    if (text !== session.expectedText) {
      throw relayError('INVALID_CONTENT', 'The synthetic browser content did not match the relay challenge.');
    }
    session.completed = { relay_id: relayId, status: 'ready', request_id: requestId, text, source: 'browser_component' };
    return { accepted: true, duplicate: false };
  }

  close(relayId: string, ticket: string, binding = ''): void {
    const session = this.authorize(relayId, ticket, binding);
    this.remove(relayId, session);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [relayId, session] of this.sessions) {
      this.remove(relayId, session);
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw relayError('CLOSED', 'The browser relay service stopped.');
  }

  private assertBinding(binding: string): void {
    if (typeof binding !== 'string' || binding.length > 256) throw relayError('INVALID_ARGUMENT', 'The relay session binding is invalid.');
  }

  private get(relayId: string, binding: string): RelaySession {
    this.assertOpen();
    this.assertBinding(binding);
    const session = this.sessions.get(relayId);
    if (!session || session.binding !== binding) throw relayError('NOT_FOUND', 'The relay probe is unavailable in this session.');
    if (this.now() >= session.expiresAt) {
      this.expire(relayId, session);
      throw relayError('EXPIRED', 'The browser relay probe expired.');
    }
    return session;
  }

  private authorize(relayId: string, ticket: string, binding: string): RelaySession {
    let session: RelaySession;
    try { session = this.get(relayId, binding); }
    catch (error) {
      if (error instanceof AppError && error.code === 'RELAY_NOT_FOUND') {
        throw relayError('ACCESS_DENIED', 'The browser relay credential is invalid or unavailable.');
      }
      throw error;
    }
    const candidate = typeof ticket === 'string' && /^[A-Za-z0-9_-]{43}$/.test(ticket) ? Buffer.from(ticket) : Buffer.alloc(43);
    if (!timingSafeEqual(candidate, session.ticketBytes)) throw relayError('ACCESS_DENIED', 'The browser relay credential is invalid or unavailable.');
    return session;
  }

  private remove(relayId: string, session: RelaySession): void {
    if (this.sessions.get(relayId) !== session) return;
    this.sessions.delete(relayId);
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.ticketBytes.fill(0);
    session.expectedText = '';
    session.completed = undefined;
  }

  private expire(relayId: string, session: RelaySession): void {
    this.remove(relayId, session);
  }

  private prune(): void {
    const now = this.now();
    for (const [relayId, session] of this.sessions) if (now >= session.expiresAt) this.expire(relayId, session);
  }
}
