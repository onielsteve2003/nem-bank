import type { StaffLoginChallenge } from '@nem/contracts';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';

import { isApiError } from '@/data/errors';
import { useDemoControls } from '@/data/provider';
import { DEMO_PASSWORD } from '@/data/mock/state';

import { DemoAccounts } from './DemoAccounts';
import { DemoAuthenticator } from './DemoAuthenticator';
import { EnrolmentQr } from './EnrolmentQr';
import { useStaffLogin, useVerifyTotp } from './useAuth';

const errorText = (error: unknown) =>
  isApiError(error) ? error.message : 'Something went wrong. Try again.';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<StaffLoginChallenge | null>(null);
  const login = useStaffLogin();
  const demo = useDemoControls();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ email, password }, { onSuccess: setChallenge });
  };

  return (
    <main className="login">
      <div className="login-panel">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          Nem Console
        </div>
        {challenge ? (
          <TotpStep
            email={email}
            challenge={challenge}
            onRestart={() => {
              setChallenge(null);
              login.reset();
            }}
          />
        ) : (
          <form className="card stack" onSubmit={onSubmit} noValidate>
            <h1>Staff sign in</h1>
            <label className="field">
              Work email
              <input
                className="input"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="field">
              Password
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                required
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {login.isError && (
              <p className="field-error" role="alert">
                {errorText(login.error)}
              </p>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={login.isPending || !email || password.length < 10}
            >
              {login.isPending ? 'Checking…' : 'Continue'}
            </button>
          </form>
        )}
        {!challenge && demo && (
          <DemoAccounts
            onPick={(pickedEmail) => {
              setEmail(pickedEmail);
              setPassword(DEMO_PASSWORD);
            }}
          />
        )}
      </div>
    </main>
  );
}

function TotpStep({
  email,
  challenge,
  onRestart,
}: {
  email: string;
  challenge: StaffLoginChallenge;
  onRestart: () => void;
}) {
  const [code, setCode] = useState('');
  const verify = useVerifyTotp();
  const demo = useDemoControls();
  const { redirect } = useSearch({ from: '/login' });
  const navigate = useNavigate();
  const secret = demo?.totpSecretFor(email) ?? null;
  const restartNeeded =
    isApiError(verify.error, 'otp_expired') || isApiError(verify.error, 'rate_limited');

  const submit = (value: string) =>
    verify.mutate(
      { challenge_id: challenge.challenge_id, code: value },
      // Only same-app paths, so a crafted link can't bounce staff to another site.
      { onSuccess: () => void navigate({ to: redirect?.startsWith('/') ? redirect : '/' }) },
    );

  return (
    <div className="stack">
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit(code);
        }}
      >
        {challenge.totp_enrolment ? (
          <EnrolmentQr uri={challenge.totp_enrolment.otpauth_uri} />
        ) : (
          <>
            <h1>Two-step sign in</h1>
            <p className="muted">Enter the 6-digit code from your authenticator app.</p>
          </>
        )}
        <label className="field">
          Authenticator code
          <input
            className="input num otp-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            autoFocus
          />
        </label>
        {verify.isError && (
          <p className="field-error" role="alert">
            {errorText(verify.error)}
          </p>
        )}
        <div className="row">
          {restartNeeded ? (
            <button type="button" className="btn btn-primary" onClick={onRestart}>
              Start again
            </button>
          ) : (
            <button
              type="submit"
              className="btn btn-primary"
              disabled={code.length !== 6 || verify.isPending}
            >
              {verify.isPending ? 'Verifying…' : 'Sign in'}
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onRestart}>
            Use a different account
          </button>
        </div>
      </form>
      {secret && (
        <DemoAuthenticator
          secret={secret}
          onUse={(value) => {
            setCode(value);
            submit(value);
          }}
        />
      )}
    </div>
  );
}
