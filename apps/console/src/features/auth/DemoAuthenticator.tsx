import { useEffect, useState } from 'react';

import { totp, totpSecondsLeft } from '@/lib/totp';

type Props = { secret: string; onUse: (code: string) => void };

/** Stands in for the phone authenticator so anyone can try the demo's TOTP step. */
export function DemoAuthenticator({ secret, onUse }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const code = totp(secret, now);
  const left = totpSecondsLeft(now);

  return (
    <div className="card demo-auth" aria-label="Demo authenticator">
      <div className="stack">
        <span className="badge">Demo authenticator</span>
        <span className="num otp-code" aria-live="polite">
          {code.slice(0, 3)} {code.slice(3)}
        </span>
        <span className="muted">New code in {left}s</span>
      </div>
      <button type="button" className="btn" onClick={() => onUse(code)}>
        Use this code
      </button>
    </div>
  );
}
