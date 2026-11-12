import { probe, wakeBank } from './bankWarmup';

const ok = () => Promise.resolve(new Response('{}', { status: 200 }));
const status = (code: number) => () => Promise.resolve(new Response('', { status: code }));

/** A fake clock: sleeping advances time, so nothing waits in real time. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

const noSchedule = () => () => undefined;

describe('probe', () => {
  it('is true for a 2xx and false for a 503 or a network failure', async () => {
    expect(await probe('https://api.test/', '/readyz', { fetch: ok, timeoutMs: 100 })).toBe(true);
    expect(await probe('https://api.test', '/readyz', { fetch: status(503), timeoutMs: 100 })).toBe(
      false,
    );
    const down = () => Promise.reject(new TypeError('Network request failed'));
    expect(await probe('https://api.test', '/healthz', { fetch: down, timeoutMs: 100 })).toBe(
      false,
    );
  });

  it('asks the right path on the API origin', async () => {
    const fetch = jest.fn(ok);
    await probe('https://api.test/', '/healthz', { fetch, timeoutMs: 100 });
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://api.test/healthz');
  });

  it('gives up on a request that never answers', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    expect(
      await probe('https://api.test', '/readyz', {
        fetch: hang as unknown as typeof fetch,
        timeoutMs: 20,
      }),
    ).toBe(false);
  });
});

describe('wakeBank', () => {
  it('is ready at once when the bank is awake, without calling it slow', async () => {
    const onSlow = jest.fn();
    const result = await wakeBank({
      baseUrl: 'https://api.test',
      fetch: ok,
      onSlow,
      schedule: noSchedule,
    });
    expect(result).toBe('ready');
    expect(onSlow).not.toHaveBeenCalled();
  });

  it('keeps asking while the host wakes, says so once, then is ready', async () => {
    const c = clock();
    const answers = [503, 502, 503, 200];
    const fetch = jest.fn(() => Promise.resolve(new Response('', { status: answers.shift()! })));
    const onSlow = jest.fn();
    const result = await wakeBank({
      baseUrl: 'https://api.test',
      fetch,
      onSlow,
      sleep: c.sleep,
      now: c.now,
      schedule: noSchedule,
    });
    expect(result).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it('calls it slow when the first probe is still pending after the slow threshold', async () => {
    const onSlow = jest.fn();
    let fire: () => void = () => undefined;
    const result = await wakeBank({
      baseUrl: 'https://api.test',
      fetch: () => {
        fire(); // the slow timer elapses while the probe is in flight
        return ok();
      },
      onSlow,
      schedule: (fn) => {
        fire = fn;
        return () => undefined;
      },
    });
    expect(result).toBe('ready');
    expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it('gives up after the time allowed', async () => {
    const c = clock();
    const fetch = jest.fn(status(503));
    const result = await wakeBank({
      baseUrl: 'https://api.test',
      fetch,
      sleep: c.sleep,
      now: c.now,
      schedule: noSchedule,
      giveUpAfterMs: 20_000,
    });
    expect(result).toBe('unreachable');
    expect(c.now()).toBeLessThanOrEqual(20_000);
    expect(fetch.mock.calls.length).toBeGreaterThan(2);
  });

  it('stops quietly when told to', async () => {
    const controller = new AbortController();
    const fetch = jest.fn(() => {
      controller.abort();
      return Promise.resolve(new Response('', { status: 503 }));
    });
    const result = await wakeBank({
      baseUrl: 'https://api.test',
      fetch,
      signal: controller.signal,
      schedule: noSchedule,
    });
    expect(result).toBe('aborted');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
