export const personInitial = (name: string) => [...name][0]?.toUpperCase() ?? '?';
/** One date format across the forum, e.g. 3 Nov 2026. UTC, so the server and the browser render the same text. */
export const forumDay = (iso: string) => new Intl.DateTimeFormat('en-GB', { day:'numeric', month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(iso));
