import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** First login: scan the otpauth URI into any authenticator app. */
export function EnrolmentQr({ uri }: { uri: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [uri]);
  const secret = new URL(uri).searchParams.get('secret') ?? '';

  return (
    <div className="stack">
      <h3>Set up your authenticator</h3>
      <p className="muted">
        Two-step sign-in is required for every staff account. Scan this with Google Authenticator,
        1Password or Authy, then enter the 6-digit code it shows.
      </p>
      {/* The SVG comes from qrcode-generator, built from our own URI, not user HTML. */}
      <div
        className="qr"
        role="img"
        aria-label="Authenticator QR code"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <p className="muted">
        Can't scan? Enter this key: <code className="num">{secret}</code>
      </p>
    </div>
  );
}
