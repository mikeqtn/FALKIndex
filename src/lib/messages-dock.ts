// The forum's message dock (components/forum/MessagesDock.tsx) listens for this event, so any island can open a
// conversation without loading the dock itself.
export const OPEN_MESSAGES = 'falk:messages';
export const openMessages = (username: string) => window.dispatchEvent(new CustomEvent(OPEN_MESSAGES, { detail:{ username } }));
