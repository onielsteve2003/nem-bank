const dateTime = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Africa/Lagos',
});

/** "20 Oct 2026, 3:04 pm" on the Lagos clock, whatever the phone's zone. */
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));
