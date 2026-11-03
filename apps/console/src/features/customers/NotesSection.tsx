import { useState, type FormEvent } from 'react';

import { isApiError } from '@/data/errors';
import { formatDateTime } from '@/lib/dates';

import type { Customer360 } from './types';
import { useAddNote } from './useCustomers';

const MAX_NOTE = 2000;

export function NotesSection({ userId, notes }: { userId: string; notes: Customer360['notes'] }) {
  const [body, setBody] = useState('');
  const addNote = useAddNote(userId);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (text) addNote.mutate(text, { onSuccess: () => setBody('') });
  };

  return (
    <section className="card stack" aria-labelledby="notes-title">
      <h2 id="notes-title">Staff notes</h2>
      <form className="stack" onSubmit={onSubmit}>
        <label className="field">
          Add a note (staff only, never shown to the customer)
          <textarea
            className="input textarea"
            value={body}
            maxLength={MAX_NOTE}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        {addNote.isError && (
          <p className="field-error" role="alert">
            {isApiError(addNote.error) ? addNote.error.message : 'Could not save the note.'}
          </p>
        )}
        <div>
          <button type="submit" className="btn" disabled={!body.trim() || addNote.isPending}>
            {addNote.isPending ? 'Saving…' : 'Add note'}
          </button>
        </div>
      </form>
      {notes.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        <ul className="note-list">
          {notes.map((n) => (
            <li key={n.id}>
              <p>{n.body}</p>
              <span className="muted hint">
                {n.author.name} · {formatDateTime(n.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
