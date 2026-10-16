import { parseEnv } from './env';

describe('parseEnv', () => {
  it('defaults to the mock bank when nothing is set', () => {
    expect(parseEnv({ EXPO_PUBLIC_API_MODE: undefined, EXPO_PUBLIC_API_URL: undefined })).toEqual({
      apiMode: 'mock',
      apiUrl: undefined,
    });
  });

  it('treats empty strings as unset', () => {
    expect(parseEnv({ EXPO_PUBLIC_API_MODE: '', EXPO_PUBLIC_API_URL: '' })).toEqual({
      apiMode: 'mock',
      apiUrl: undefined,
    });
  });

  it('accepts http mode with a URL and strips trailing slashes', () => {
    expect(
      parseEnv({ EXPO_PUBLIC_API_MODE: 'http', EXPO_PUBLIC_API_URL: 'http://192.168.1.20:8080/' }),
    ).toEqual({ apiMode: 'http', apiUrl: 'http://192.168.1.20:8080' });
  });

  it('requires a URL in http mode', () => {
    expect(() =>
      parseEnv({ EXPO_PUBLIC_API_MODE: 'http', EXPO_PUBLIC_API_URL: undefined }),
    ).toThrow(/EXPO_PUBLIC_API_URL is required/);
  });

  it('rejects an unknown mode', () => {
    expect(() =>
      parseEnv({ EXPO_PUBLIC_API_MODE: 'live', EXPO_PUBLIC_API_URL: undefined }),
    ).toThrow(/EXPO_PUBLIC_API_MODE/);
  });

  it('rejects URLs that are not http(s)', () => {
    expect(() =>
      parseEnv({ EXPO_PUBLIC_API_MODE: 'http', EXPO_PUBLIC_API_URL: 'ftp://api.nem.bank' }),
    ).toThrow(/EXPO_PUBLIC_API_URL/);
    expect(() =>
      parseEnv({ EXPO_PUBLIC_API_MODE: 'http', EXPO_PUBLIC_API_URL: 'not a url' }),
    ).toThrow(/EXPO_PUBLIC_API_URL/);
  });
});
