import { useState } from 'react';

/** A secret the API returns once. After this panel closes, only its prefix is ever shown. */
export function SecretOnce({
  title,
  secret,
  onDone,
}: {
  title: string;
  secret: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(secret).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <section className="card stack action-form proof" role="alert" aria-labelledby="secret-title">
      <h3 id="secret-title">{title}</h3>
      <p className="muted">
        Copy it now and keep it somewhere safe. You won&apos;t see it again: Nem stores only a hash
        of it.
      </p>
      <code className="secret num" aria-label="Secret">
        {secret}
      </code>
      <div className="row">
        <button type="button" className="btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          I&apos;ve saved it
        </button>
      </div>
    </section>
  );
}
