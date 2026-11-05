import { useAuth, useClerk } from '@clerk/react';
import { useEffect, useState } from 'react';
import type { Role } from '../../accounts/contracts';
import { api } from './api';
import { AuthProvider } from './AuthProvider';

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
      {forum && <a href={forum.replies}>Replies{unread > 0 && <span className="forum-count"> {unread}<span className="sr-only"> unread</span></span>}</a>}
      {forum && (role === 'editor' || role === 'admin') && <a href={forum.moderation}>Reports</a>}
      {!forum && (role === 'editor' || role === 'admin') && <a href={`${site}/editor/review`}>Review</a>}
      {!forum && role === 'admin' && <a href={`${site}/admin/users`}>Administration</a>}
      <a href={`${site}/account`}>Account</a>
      <button type="button" disabled={!isLoaded} onClick={() => { forget(); signOut({ redirectUrl: '/' }); }}>Sign out</button>
    </span>
  );
}

export default function AccountNavigation(props: Props) {
  return <AuthProvider><AccountNavigationInner {...props} /></AuthProvider>;
}
