import type { RealtimeEvent } from '@nem/contracts';

import { isApiError } from './errors';
import { createEmitter, type RealtimeSource, type RealtimeStatus } from './realtime';

// The WebSocket behind RealtimeSource (T31.2, architecture §4). It trades the
// session for a 30-second ticket (the socket URL carries no long-lived secret),
// connects, and hands every server event to the app. It stays up on its own:
// reconnects with backoff, asks the server to replay what it missed, drops
// duplicates by event ID and notices a connection that went quiet.

/** The slice of the WebSocket API used here, so tests can supply a fake. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface Ticket {
  ticket: string;
  url: string;
}

export interface SocketRealtimeConfig {
  /** Trades the session for a ticket; rejects with a 401 ApiError when signed out. */
  getTicket: () => Promise<Ticket>;
  createSocket?: (url: string) => SocketLike;
  /** First retry delay; doubles up to `maxDelayMs`, with jitter. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** How often the client pings, and how long silence is tolerated. */
  pingEveryMs?: number;
  silenceLimitMs?: number;
  random?: () => number;
}

export interface SocketRealtime extends RealtimeSource {
  /** Signed in: connect (when someone is listening). Signed out: close and stop retrying. */
  setActive(active: boolean): void;
}

/** Event IDs remembered to drop a duplicate delivery (a replay after a reconnect). */
const SEEN_LIMIT = 500;

export function createSocketRealtime(config: SocketRealtimeConfig): SocketRealtime {
  const baseDelay = config.baseDelayMs ?? 1_000;
  const maxDelay = config.maxDelayMs ?? 30_000;
  const pingEvery = config.pingEveryMs ?? 25_000;
  const silenceLimit = config.silenceLimitMs ?? 70_000;
  const random = config.random ?? Math.random;
  const createSocket =
    config.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);

  const events = createEmitter<RealtimeEvent>();
  const statuses = createEmitter<RealtimeStatus>();
  const seen = new Set<string>();

  let status: RealtimeStatus = 'closed';
  let active = true;
  let socket: SocketLike | null = null;
  let attempt = 0;
  let lastEventId: string | null = null;
  let lastHeard = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  // Bumped on every connect/teardown so a late callback from an old socket is ignored.
  let generation = 0;

  function setStatus(next: RealtimeStatus) {
    if (next === status) return;
    status = next;
    statuses.emit(next);
  }

  function stopTimers() {
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    retryTimer = undefined;
    pingTimer = undefined;
  }

  function teardown() {
    generation++;
    stopTimers();
    const old = socket;
    socket = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try {
        old.close();
      } catch {
        // Already closed.
      }
    }
    setStatus('closed');
  }

  function scheduleRetry() {
    if (!active || events.size === 0) return;
    const ceiling = Math.min(maxDelay, baseDelay * 2 ** attempt);
    attempt++;
    // Jitter keeps a crowd of phones from reconnecting in the same instant.
    retryTimer = setTimeout(() => void connect(), ceiling * (0.5 + random() / 2));
  }

  function onMessage(raw: unknown) {
    lastHeard = Date.now();
    if (typeof raw !== 'string') return;
    let message: Partial<RealtimeEvent> | undefined;
    try {
      message = JSON.parse(raw) as Partial<RealtimeEvent>;
    } catch {
      return;
    }
    // `pong` and anything this version does not know carry no event ID.
    if (!message || typeof message.id !== 'string' || typeof message.type !== 'string') return;
    if (seen.has(message.id)) return;
    seen.add(message.id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
    lastEventId = message.id;
    events.emit(message as RealtimeEvent);
  }

  async function connect() {
    if (!active || events.size === 0 || socket) return;
    const mine = ++generation;
    setStatus('connecting');
    let ticket: Ticket;
    try {
      ticket = await config.getTicket();
    } catch (error) {
      if (mine !== generation) return;
      setStatus('closed');
      // Signed out: wait for setActive(true) rather than retrying with no session.
      if (!(isApiError(error) && error.status === 401)) scheduleRetry();
      return;
    }
    if (mine !== generation) return;

    const next = createSocket(`${ticket.url}?ticket=${encodeURIComponent(ticket.ticket)}`);
    socket = next;
    next.onopen = () => {
      if (mine !== generation) return;
      const reconnecting = attempt > 0 || lastEventId !== null;
      attempt = 0;
      lastHeard = Date.now();
      setStatus('open');
      // Ask for what was missed while away; duplicates are dropped by ID.
      if (reconnecting && lastEventId) {
        next.send(JSON.stringify({ type: 'resume', last_event_id: lastEventId }));
      }
      pingTimer = setInterval(() => {
        if (Date.now() - lastHeard > silenceLimit) {
          // Silent for too long: the phone changed network without the socket noticing.
          dropAndRetry();
          return;
        }
        next.send(JSON.stringify({ type: 'ping' }));
      }, pingEvery);
    };
    next.onmessage = (message) => {
      if (mine === generation) onMessage(message.data);
    };
    next.onclose = () => {
      if (mine === generation) dropAndRetry();
    };
    next.onerror = () => {
      // A close follows an error; nothing to do until then.
    };
  }

  function dropAndRetry() {
    teardown();
    scheduleRetry();
  }

  return {
    subscribe(listener) {
      const stop = events.subscribe(listener);
      if (events.size === 1) void connect();
      return () => {
        stop();
        if (events.size === 0) teardown();
      };
    },
    status: () => status,
    onStatus: (listener) => statuses.subscribe(listener),
    setActive(next) {
      if (next === active) return;
      active = next;
      if (!active) {
        attempt = 0;
        lastEventId = null;
        seen.clear();
        teardown();
      } else {
        void connect();
      }
    },
  };
}
