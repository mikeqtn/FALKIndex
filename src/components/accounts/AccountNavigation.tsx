import { useAuth, useClerk } from '@clerk/react';
import { useEffect, useState } from 'react';
import type { Role } from '../../accounts/contracts';
import { api } from './api';
import { AuthProvider } from './AuthProvider';

interface Props {
  site?: string; // the main site's origin, when this menu is shown on the forum's host
  forum?: { replies: string, moderation: string }; // the forum's own pages, on forum pages
}

function AccountNavigationInner({ site = '', forum }: Props) {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const [role, setRole] = useState<Role | null>(null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let active = true;
    if (isLoaded && isSignedIn) {
      api<{ account: { role: Role } }>('/api/account')
        .then(({ account }) => { if (active) setRole(account.role); })
        .catch(() => { if (active) setRole(null); });
      if (forum) api<{ unread: number }>('/api/forum/notifications')
        .then(({ unread }) => { if (active) setUnread(unread); })
        .catch(() => {});
    } else {
      setRole(null);
    }
    return () => { active = false; };
  }, [isLoaded, isSignedIn, !forum]);

  if (!isLoaded) return <span className="account-nav" role="status"><span className="sr-only">Loading account navigation</span><span className="account-skeleton" style={{ width: 84 }} aria-hidden="true" /></span>;
  if (!isSignedIn) return (
    <span className="account-nav">
      <a href="/sign-in">Sign in</a>
      <a className="account-button" href="/sign-up">Create account</a>
    </span>
  );
  return (
    <span className="account-nav">
      {forum && <a href={forum.replies}>Replies{unread > 0 && <span className="forum-count"> {unread}<span className="sr-only"> unread</span></span>}</a>}
      {forum && (role === 'editor' || role === 'admin') && <a href={forum.moderation}>Reports</a>}
      {!forum && (role === 'editor' || role === 'admin') && <a href={`${site}/editor/review`}>Review</a>}
      {!forum && role === 'admin' && <a href={`${site}/admin/users`}>Administration</a>}
      <a href={`${site}/account`}>Account</a>
      <button type="button" onClick={() => signOut({ redirectUrl: '/' })}>Sign out</button>
    </span>
  );
}

export default function AccountNavigation(props: Props) {
  return <AuthProvider><AccountNavigationInner {...props} /></AuthProvider>;
}
