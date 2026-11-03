import type { Schema } from '@nem/contracts';
import { useState } from 'react';

import { Badge } from '@/components/Badge';

import { DOCUMENT_LABELS, QUALITY_LABELS } from './labels';

type Document = Schema<'KycReview'>['documents'][number];

const DOC_STATUS = {
  uploaded: ['Not checked', 'neutral'],
  accepted: ['Accepted', 'success'],
  rejected: ['Rejected', 'danger'],
} as const;

/** One document at a time, large enough to check, with zoom and rotate for phone photos. */
export function DocumentViewer({ documents }: { documents: Document[] }) {
  const [selectedId, setSelectedId] = useState(documents[0]?.id);
  const [zoomed, setZoomed] = useState(false);
  const [turns, setTurns] = useState(0);
  const doc = documents.find((d) => d.id === selectedId) ?? documents[0];

  if (!doc) {
    return (
      <section className="card stack" aria-labelledby="docs-title">
        <h2 id="docs-title">Documents</h2>
        <p className="muted">
          This upgrade needs no documents. Decide on the BVN and NIN checks alone.
        </p>
      </section>
    );
  }

  const select = (id: string) => {
    setSelectedId(id);
    setZoomed(false);
    setTurns(0);
  };
  const [statusLabel, statusTone] = DOC_STATUS[doc.status];

  return (
    <section className="card stack" aria-labelledby="docs-title">
      <h2 id="docs-title">Documents</h2>
      <div className="segmented" role="group" aria-label="Choose a document">
        {documents.map((d) => (
          <button
            key={d.id}
            type="button"
            className="segment"
            aria-pressed={d.id === doc.id}
            onClick={() => select(d.id)}
          >
            {DOCUMENT_LABELS[d.kind]}
            {(d.quality_issues?.length ?? 0) > 0 && <span aria-label=", has issues"> ⚠</span>}
          </button>
        ))}
      </div>
      <div className="doc-stage" data-zoomed={zoomed}>
        <img
          src={doc.url}
          alt={`${DOCUMENT_LABELS[doc.kind]} uploaded by the customer`}
          style={{ transform: `rotate(${turns * 90}deg)` }}
        />
      </div>
      <div className="row space-between">
        <p className="row">
          <Badge tone={statusTone}>{statusLabel}</Badge>
          {doc.quality_issues?.map((q) => (
            <Badge key={q} tone="warning">
              ⚠ {QUALITY_LABELS[q]}
            </Badge>
          ))}
        </p>
        <div className="row">
          <button
            type="button"
            className="btn"
            aria-pressed={zoomed}
            onClick={() => setZoomed((z) => !z)}
          >
            {zoomed ? 'Fit to frame' : 'Zoom to 200%'}
          </button>
          <button type="button" className="btn" onClick={() => setTurns((t) => (t + 1) % 4)}>
            Rotate
          </button>
        </div>
      </div>
      <p className="muted hint">
        Opening a document is audit-logged. Links are signed for five minutes and refresh on their
        own.
      </p>
    </section>
  );
}
