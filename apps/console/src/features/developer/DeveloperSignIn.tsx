import { useState, type FormEvent } from 'react';

import { isApiError } from '@/data/errors';

import { useDeveloperLogin } from './useDeveloper';

/** Real API only: the portal's routes are a business customer's, so it signs in as one. */
export function DeveloperSignIn() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const login = useDeveloperLogin();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ identifier: identifier.trim(), password });
  };

  return (
    <main className="login">
      <div className="login-panel">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          Nem for Developers
        </div>
        <form className="card stack" onSubmit={submit} noValidate>
          <h1>Sign in</h1>
          <p className="muted">
            Use the email and password of your Nem customer account. Keys and webhooks belong to
            that account and only reach the sandbox.
          </p>
          <label className="field">
            Email or phone
            <input
              className="input"
              autoComplete="username"
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </label>
          <label className="field">
            Password
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {login.isError && (
            <p className="field-error" role="alert">
              {isApiError(login.error) ? login.error.message : 'Something went wrong. Try again.'}
            </p>
          )}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={login.isPending || !identifier.trim() || !password}
          >
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
