import type { RealtimeEvent } from '@nem/contracts';

import { problem } from '../errors';
import { createSocketRealtime, type SocketLike } from '../socketRealtime';

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  push(body: unknown) {
    this.onmessage?.({ data: JSON.stringify(body) });
  }
  drop() {
    this.onclose?.();
  }
}

const event = (id: string, type = 'notification.created') =>
  ({ id, type, occurred_at: '2026-11-12T10:00:00Z', data: {} }) as unknown as RealtimeEvent;

function setup(getTicket?: () => Promise<{ ticket: string; url: string }>) {
  const sockets: FakeSocket[] = [];
  const realtime = createSocketRealtime({
    getTicket: getTicket ?? (async () => ({ ticket: 't 1', url: 'wss://api.test/v1/realtime' })),
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    random: () => 1,
    baseDelayMs: 1000,
  });
  return { realtime, sockets };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('socket realtime', () => {
  it('connects with a ticket on the first listener and delivers events', async () => {
    const { realtime, sockets } = setup();
    const heard: RealtimeEvent[] = [];
    realtime.subscribe((e) => heard.push(e));
    await flush();
    expect(sockets[0]!.url).toBe('wss://api.test/v1/realtime?ticket=t%201');
    expect(realtime.status()).toBe('connecting');
    sockets[0]!.open();
    expect(realtime.status()).toBe('open');
    sockets[0]!.push(event('e1'));
    expect(heard.map((e) => e.id)).toEqual(['e1']);
  });

  it('drops duplicates and messages without an event ID', async () => {
    const { realtime, sockets } = setup();
    const heard: RealtimeEvent[] = [];
    realtime.subscribe((e) => heard.push(e));
    await flush();
    sockets[0]!.open();
    sockets[0]!.push(event('e1'));
    sockets[0]!.push(event('e1'));
    sockets[0]!.push({ type: 'pong' });
    sockets[0]!.onmessage?.({ data: 'not json' });
    expect(heard).toHaveLength(1);
  });

  it('reconnects with backoff and asks for what it missed', async () => {
    const { realtime, sockets } = setup();
    const statuses: string[] = [];
    realtime.onStatus((s) => statuses.push(s));
    realtime.subscribe(() => undefined);
    await flush();
    sockets[0]!.open();
    sockets[0]!.push(event('e7'));
    sockets[0]!.drop();
    expect(realtime.status()).toBe('closed');
    await jest.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toContain(JSON.stringify({ type: 'resume', last_event_id: 'e7' }));
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting', 'open']);
  });

  it('closes when the last listener leaves', async () => {
    const { realtime, sockets } = setup();
    const stop = realtime.subscribe(() => undefined);
    await flush();
    sockets[0]!.open();
    stop();
    expect(sockets[0]!.closed).toBe(true);
    expect(realtime.status()).toBe('closed');
  });

  it('stops while signed out and reconnects when signed in again', async () => {
    const { realtime, sockets } = setup();
    realtime.subscribe(() => undefined);
    await flush();
    sockets[0]!.open();
    realtime.setActive(false);
    expect(sockets[0]!.closed).toBe(true);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    realtime.setActive(true);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it('does not retry a ticket the server refused as unauthenticated', async () => {
    const getTicket = jest.fn().mockRejectedValue(problem(401, 'session_expired', 'Ended'));
    const { realtime } = setup(getTicket);
    realtime.subscribe(() => undefined);
    await flush();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(realtime.status()).toBe('closed');
  });

  it('retries when the ticket request fails for another reason', async () => {
    const getTicket = jest
      .fn()
      .mockRejectedValueOnce(problem(503, 'network_error', 'Offline'))
      .mockResolvedValue({ ticket: 't', url: 'wss://api.test/v1/realtime' });
    const { realtime, sockets } = setup(getTicket);
    realtime.subscribe(() => undefined);
    await flush();
    await jest.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(1);
  });

  it('reconnects when the connection goes silent', async () => {
    const { realtime, sockets } = setup();
    realtime.subscribe(() => undefined);
    await flush();
    sockets[0]!.open();
    await jest.advanceTimersByTimeAsync(25_000);
    expect(sockets[0]!.sent).toContain(JSON.stringify({ type: 'ping' }));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sockets[0]!.closed).toBe(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  });
});
