import { useAuth, useClerk } from '@clerk/react';
import { useEffect, useState } from 'react';
import type { Role } from '../../accounts/contracts';
import { api } from './api';
import { AuthProvider } from './AuthProvider';
import { setSessionHint } from '../../accounts/session-hint.ts';

// Each item has an icon and a label. The icons show only where a page asks for them (the forum's top bar on phones,
// forum.css), which then hides the label visually but keeps it as the item's name for screen readers.
const ICONS = {
  replies: 'M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Zm4 10.5a2.2 2.2 0 0 0 4 0',
  reports: 'M5 21V4m0 0h11l-2 4 2 4H5',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7.5 8.5a7.5 7.5 0 0 1 15 0',
  signOut: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10',
};
const Item = ({ icon, label }: { icon: keyof typeof ICONS, label: string }) => <>
  <svg className="account-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[icon]} /></svg>
  <span className="account-nav-label">{label}</span>
</>;

interface Props {
  site?: string; // the main site's origin, when this menu is shown on the forum's host
  forum?: { replies: string, moderation: string }; // the forum's own pages, on forum pages
}
interface Menu { role: Role | null, unread: number }

// Remembered for this tab so each page draws the menu at once. It only chooses which links to show; the server checks
// every action. Each site has its own copy, so after signing out on the other site this one can show old links until /api/account answers.
const REMEMBERED = 'falk-account-menu';
const NOTHING: Menu = { role:null, unread:0 };
const remembered = (): Menu => {
  try { return { ...NOTHING, ...JSON.parse(sessionStorage.getItem(REMEMBERED) ?? 'null') }; } catch { return NOTHING; }
};
const forget = () => { try { sessionStorage.removeItem(REMEMBERED); } catch {} };

function AccountNavigationInner({ site = '', forum }: Props) {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const [menu, setMenu] = useState(remembered);
  const { role, unread } = menu;

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { forget(); setMenu(NOTHING); return; }
    let active = true;
    api<{ account: { role: Role } }>('/api/account')
      .then(({ account }) => { if (active) setMenu(m => ({ ...m, role:account.role })); })
      .catch(() => { if (active) setMenu(m => ({ ...m, role:null })); });
    if (forum) api<{ unread: number }>('/api/forum/notifications')
      .then(({ unread }) => { if (active) setMenu(m => ({ ...m, unread })); })
      .catch(() => {});
    return () => { active = false; };
  }, [isLoaded, isSignedIn, !forum]);

  useEffect(() => {
    if (isSignedIn) try { sessionStorage.setItem(REMEMBERED, JSON.stringify(menu)); } catch {}
  }, [menu, isSignedIn]);

  if (isLoaded && !isSignedIn) return (
    <span className="account-nav">
      <a href="/sign-in">Sign in</a>
      <a className="account-button" href="/sign-up">Create account</a>
    </span>
  );
  // The server drew this menu because the session cookie says signed in, so it shows while Clerk loads.
  return (
    <span className="account-nav">
      {forum && <a href={forum.replies}><Item icon="replies" label="Replies" />{unread > 0 && <span className="forum-count"> {unread}<span className="sr-only"> unread</span></span>}</a>}
      {forum && (role === 'editor' || role === 'admin') && <a href={forum.moderation}><Item icon="reports" label="Reports" /></a>}
      {!forum && (role === 'editor' || role === 'admin') && <a href={`${site}/editor/review`}>Review</a>}
      {!forum && role === 'admin' && <a href={`${site}/admin/users`}>Administration</a>}
      <a href={`${site}/account`}><Item icon="account" label="Account" /></a>
      <button type="button" disabled={!isLoaded} onClick={() => { forget(); setSessionHint(false); signOut({ redirectUrl: '/' }); }}><Item icon="signOut" label="Sign out" /></button>
    </span>
  );
}

export default function AccountNavigation(props: Props) {
  return <AuthProvider><AccountNavigationInner {...props} /></AuthProvider>;
}
