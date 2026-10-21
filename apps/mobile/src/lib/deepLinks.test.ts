import { hrefToPath, parseLink, resolveDeepLink } from './deepLinks';

const path = (url: string) => hrefToPath(resolveDeepLink(url).href);

describe('resolveDeepLink', () => {
  it('opens a payment link from the custom scheme, the web and Expo Go', () => {
    expect(path('nembank://pay/k3x9q2ab')).toBe('/pay/k3x9q2ab');
    expect(path('https://nem-bank-fodx.vercel.app/pay/k3x9q2ab')).toBe('/pay/k3x9q2ab');
    expect(path('exp://192.168.1.4:8081/--/pay/k3x9q2ab')).toBe('/pay/k3x9q2ab');
    expect(path('/pay/k3x9q2ab')).toBe('/pay/k3x9q2ab');
  });

  it('opens an ajo invite', () => {
    expect(path('https://nem-bank-fodx.vercel.app/ajo/AB12CD')).toBe('/ajo/AB12CD');
  });

  it('routes a raw QR payload and a QR link to the QR pay screen', () => {
    const payload = 'NEMQR1|0123456789|-|-|sig';
    expect(path(payload)).toBe(`/qr?payload=${encodeURIComponent(payload)}`);
    expect(path(`nembank://qr?payload=${encodeURIComponent(payload)}`)).toBe(
      `/qr?payload=${encodeURIComponent(payload)}`,
    );
    expect(path('nembank://qr?payload=not-a-nem-code')).toBe('/pay');
  });

  it('maps notification deep links to the closest screen that exists', () => {
    expect(path('nembank://transfers/0192f1aa-7b3c-7000-8000-000000000001')).toBe('/home');
    expect(path('nembank://pay/requests/abc')).toBe('/send/requests');
    expect(path('nembank://transfers/scheduled/abc')).toBe('/send/scheduled');
    expect(path('nembank://grow/ajo/abc')).toBe('/grow');
    expect(path('nembank://me/verification')).toBe('/kyc');
    expect(path('nembank://security/devices')).toBe('/me');
    expect(path('nembank://fx')).toBe('/convert');
  });

  it('marks signed-out screens as public and the rest as needing auth', () => {
    expect(resolveDeepLink('nembank://login').requiresAuth).toBe(false);
    expect(resolveDeepLink('nembank://pay/abc').requiresAuth).toBe(true);
  });

  it('falls back to Home for unknown paths, foreign hosts and junk', () => {
    expect(path('nembank://nowhere/at/all')).toBe('/home');
    expect(path('https://evil.example.com/pay/abc')).toBe('/home');
    expect(path('javascript:alert(1)')).toBe('/home');
    expect(path('nembank://pay/%E0%A4%A')).toBe('/home');
    expect(path('nembank://pay/<script>')).toBe('/home');
  });

  it('treats the bare scheme as the app entry point', () => {
    expect(path('nembank://')).toBe('/');
  });
});

describe('parseLink', () => {
  it('rejects links that are not ours', () => {
    expect(parseLink('mailto:ada@example.com')).toBeNull();
    expect(parseLink('https://example.com/pay/abc')).toBeNull();
  });
});
