import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** A status chip. The text always carries the meaning; the tone only reinforces it. */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}
