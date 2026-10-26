import type { Href } from 'expo-router';

// One place that turns any link the app can be opened with into a route:
//   nembank://pay/k3x9q2ab                 custom scheme (notifications, QR codes)
//   https://nem-bank-fodx.vercel.app/pay/… the public web links we share
//   exp://192.168.1.4:8081/--/pay/…        Expo Go in development
//   NEMQR1|… or nem1.…                     a raw QR payload from the scanner
// Notification `deep_link`s point at screens that later milestones build; until
// a screen exists its link opens the closest tab, so no link ever dead-ends.

export const APP_SCHEME = 'nembank';
export const WEB_HOSTS = ['nem-bank-fodx.vercel.app'] as const;

export type ResolvedLink = {
  href: Href;
  /** False for the signed-out screens; everything else sits behind the auth gate. */
  requiresAuth: boolean;
};

type Route = {
  pattern: string;
  to: (params: Record<string, string>, query: URLSearchParams) => Href;
  public?: boolean;
};

// First match wins, so specific patterns come before their prefixes.
const ROUTES: Route[] = [
  // Payment links and QR (TRF-12, TRF-13)
  { pattern: 'pay/requests/:id', to: () => '/send/requests' },
  {
    pattern: 'pay/:slug',
    to: ({ slug = '' }) => ({ pathname: '/pay/[slug]', params: { slug } }),
    public: true,
  },
  { pattern: 'send/links', to: () => '/send/links' },
  { pattern: 'pay', to: () => '/pay' },
  { pattern: 'qr', to: (_, q) => qrHref(q.get('payload') ?? q.get('p') ?? '') },
  // Ajo invites (AJO-2)
  { pattern: 'ajo/:code', to: ({ code = '' }) => ({ pathname: '/ajo/[code]', params: { code } }) },
  // Notification targets (NOT-1)
  { pattern: 'home', to: () => '/home' },
  { pattern: 'transactions/:id', to: () => '/home' },
  { pattern: 'transfers/scheduled/:id', to: () => '/send/scheduled' },
  { pattern: 'transfers/:id', to: () => '/home' },
  { pattern: 'send', to: () => '/send' },
  { pattern: 'fx', to: () => '/convert' },
  { pattern: 'convert', to: () => '/convert' },
  { pattern: 'bills', to: () => '/pay' },
  { pattern: 'cards', to: () => '/cards' },
  { pattern: 'cards/:id', to: () => '/cards' },
  { pattern: 'grow', to: () => '/grow' },
  {
    pattern: 'grow/goals/:id',
    to: ({ id = '' }) => ({ pathname: '/goals/[id]', params: { id } }),
  },
  { pattern: 'grow/round-ups', to: () => '/round-ups' },
  {
    pattern: 'grow/locks/:id',
    to: ({ id = '' }) => ({ pathname: '/locks/[id]', params: { id } }),
  },
  { pattern: 'grow/ajo', to: () => '/ajo' },
  {
    pattern: 'grow/ajo/:id',
    to: ({ id = '' }) => ({ pathname: '/ajo/group/[id]', params: { id } }),
  },
  { pattern: 'grow/credit', to: () => '/credit' },
  { pattern: 'grow/*', to: () => '/grow' },
  { pattern: 'me', to: () => '/me' },
  { pattern: 'me/verification', to: () => '/kyc' },
  { pattern: 'kyc', to: () => '/kyc' },
  { pattern: 'security', to: () => '/me' },
  { pattern: 'security/*', to: () => '/me' },
  { pattern: 'family', to: () => '/me' },
  { pattern: 'family/*', to: () => '/me' },
  { pattern: 'disputes/:id', to: () => '/me' },
  { pattern: 'demo-controls', to: () => '/demo-controls' },
  // Signed-out screens
  { pattern: 'welcome', to: () => '/welcome', public: true },
  { pattern: 'login', to: () => '/login', public: true },
  { pattern: 'sign-up', to: () => '/sign-up', public: true },
];

const FALLBACK: ResolvedLink = { href: '/home', requiresAuth: true };

const isQrPayload = (value: string) => value.startsWith('NEMQR1|') || value.startsWith('nem1.');

function qrHref(payload: string): Href {
  return isQrPayload(payload) ? { pathname: '/qr', params: { payload } } : '/pay';
}

/** Splits a link into its in-app path segments and query, or null if it is not ours. */
export function parseLink(input: string): { segments: string[]; query: URLSearchParams } | null {
  const raw = input.trim();
  let path: string;
  let search = '';

  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i.exec(raw);
  if (scheme) {
    const [, protocol = '', host = '', rest = '', query = ''] = scheme;
    search = query;
    const proto = protocol.toLowerCase();
    if (proto === APP_SCHEME) {
      // In nembank://pay/abc the "host" is really the first path segment.
      path = `${host}${rest}`;
    } else if (proto === 'exp' || proto === 'exps') {
      const marker = rest.indexOf('/--/');
      path = marker === -1 ? '' : rest.slice(marker + 4);
    } else if (proto === 'https' || proto === 'http') {
      const hostname = host.toLowerCase().split(':')[0] ?? '';
      const known = (WEB_HOSTS as readonly string[]).includes(hostname) || hostname === 'localhost';
      if (!known) return null;
      path = rest;
    } else {
      return null;
    }
  } else if (raw.startsWith('/')) {
    // Expo Router hands +native-intent a path that has already lost its scheme.
    const queryAt = raw.indexOf('?');
    path = queryAt === -1 ? raw : raw.slice(0, queryAt);
    search = queryAt === -1 ? '' : raw.slice(queryAt);
  } else {
    return null;
  }

  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => safeDecode(s));
  return { segments, query: new URLSearchParams(search) };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function match(pattern: string, segments: string[]): Record<string, string> | null {
  const parts = pattern.split('/');
  const wildcard = parts[parts.length - 1] === '*';
  const fixed = wildcard ? parts.slice(0, -1) : parts;
  if (wildcard ? segments.length <= fixed.length : segments.length !== fixed.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < fixed.length; i += 1) {
    const part = fixed[i]!;
    const segment = segments[i]!;
    if (part.startsWith(':')) {
      // Slugs, ids and invite codes are short tokens; anything else is not a link we made.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(segment)) return null;
      params[part.slice(1)] = segment;
    } else if (part !== segment.toLowerCase()) {
      return null;
    }
  }
  return params;
}

/**
 * Resolves any incoming link or scanned QR text to an app route. Links that are
 * not ours, or that point nowhere we know, open Home rather than an error page.
 */
export function resolveDeepLink(input: string): ResolvedLink {
  const raw = input.trim();
  if (isQrPayload(raw)) return { href: qrHref(raw), requiresAuth: true };

  const parsed = parseLink(raw);
  if (!parsed) return FALLBACK;
  if (parsed.segments.length === 0) return { href: '/', requiresAuth: false };

  for (const route of ROUTES) {
    const params = match(route.pattern, parsed.segments);
    if (params) return { href: route.to(params, parsed.query), requiresAuth: !route.public };
  }
  return FALLBACK;
}

/** The route as a path string, for APIs such as +native-intent that take one. */
export function hrefToPath(href: Href): string {
  if (typeof href === 'string') return href;
  const params = { ...(href.params as Record<string, string | undefined>) };
  let path: string = href.pathname.replace(/\[([^\]]+)\]/g, (_, key: string) => {
    const value = params[key] ?? '';
    delete params[key];
    return encodeURIComponent(value);
  });
  const query = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined),
  ).toString();
  if (query) path += `?${query}`;
  return path;
}
