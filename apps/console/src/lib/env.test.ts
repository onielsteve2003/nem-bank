import { describe, expect, it } from 'vitest';

import { readEnv } from './env';

describe('console env', () => {
  it('defaults to the mock bank', () => {
    expect(readEnv({})).toEqual({ apiMode: 'mock', apiUrl: '' });
  });

  it('reads the API origin in http mode and drops trailing slashes', () => {
    expect(readEnv({ VITE_API_MODE: 'http', VITE_API_URL: 'https://api.example.com//' })).toEqual({
      apiMode: 'http',
      apiUrl: 'https://api.example.com',
    });
  });

  it('refuses http mode without a usable URL', () => {
    expect(() => readEnv({ VITE_API_MODE: 'http' })).toThrow('VITE_API_URL');
    expect(() => readEnv({ VITE_API_MODE: 'http', VITE_API_URL: 'ftp://x' })).toThrow(
      'VITE_API_URL',
    );
  });

  it('refuses an unknown mode', () => {
    expect(() => readEnv({ VITE_API_MODE: 'live' })).toThrow('VITE_API_MODE');
  });
});
