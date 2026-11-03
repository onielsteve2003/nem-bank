import { useState } from 'react';

import { Badge } from '@/components/Badge';
import { ErrorState, Skeleton } from '@/components/PageState';
import { ReasonForm } from '@/components/ReasonForm';
import { formatDateTime } from '@/lib/dates';

import { useFeatureFlags, useUpdateFlag, type FeatureFlag } from './useConfig';

/** "international_transfers" → "International transfers". */
const flagName = (key: string) => {
  const words = key.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Feature flags, including the paid-feature toggles that stay off on $0 services (PRD §11). */
export function FeatureFlagsPage() {
  const flags = useFeatureFlags();
  const update = useUpdateFlag();
  const [selected, setSelected] = useState<FeatureFlag | null>(null);

  const choose = (flag: FeatureFlag) => {
    update.reset();
    setSelected(flag);
  };

  return (
    <>
      <div className="stack tight">
        <h1>Feature flags</h1>
        <p className="muted">
          Turn features on or off for every customer. Each change is recorded with its reason.
        </p>
      </div>

      {selected &&
        (selected.paid_feature && !selected.enabled ? (
          <section className="card stack action-form" role="alert" aria-labelledby="paid-title">
            <h3 id="paid-title">{flagName(selected.key)} needs a paid partner</h3>
            <p className="muted">
              This demo runs on $0 services only. Turning this on needs a licensed partner and its
              adapter connected behind the partner interface first. Until then customers see an
              honest Paid Feature Notice instead.
            </p>
            <div>
              <button type="button" className="btn" onClick={() => setSelected(null)}>
                Got it
              </button>
            </div>
          </section>
        ) : (
          <ReasonForm
            key={selected.key}
            title={`${selected.enabled ? 'Turn off' : 'Turn on'} ${flagName(selected.key)}?`}
            description={selected.description}
            submitLabel={selected.enabled ? 'Turn off' : 'Turn on'}
            danger={selected.enabled}
            pending={update.isPending}
            error={update.error}
            onCancel={() => setSelected(null)}
            onSubmit={(reason) =>
              update.mutate(
                { key: selected.key, enabled: !selected.enabled, reason },
                { onSuccess: () => setSelected(null) },
              )
            }
          />
        ))}

      {flags.isPending ? (
        <div className="card stack" aria-busy="true" aria-label="Loading flags">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={28} />
          ))}
        </div>
      ) : flags.isError ? (
        <ErrorState error={flags.error} onRetry={() => void flags.refetch()} />
      ) : (
        <section className="card stack" aria-label="Flags">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Feature</th>
                <th scope="col">Last change</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {flags.data.data.map((flag) => (
                <tr key={flag.key}>
                  <td>
                    <div className="stack tight">
                      <span className="row">
                        <strong>{flagName(flag.key)}</strong>
                        {flag.paid_feature && <Badge tone="warning">Paid feature</Badge>}
                      </span>
                      <span className="muted hint">{flag.description}</span>
                      <span className="muted hint num">{flag.key}</span>
                    </div>
                  </td>
                  <td className="muted hint">
                    {flag.updated_by ? `${flag.updated_by.name}, ` : ''}
                    {formatDateTime(flag.updated_at)}
                  </td>
                  <td>
                    <button
                      type="button"
                      role="switch"
                      className="switch"
                      aria-checked={flag.enabled}
                      aria-label={flagName(flag.key)}
                      onClick={() => choose(flag)}
                    >
                      <span className="switch-track" aria-hidden="true">
                        <span className="switch-thumb" />
                      </span>
                      {flag.enabled ? 'On' : 'Off'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
