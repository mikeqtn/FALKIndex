import { useAuth, useClerk } from '@clerk/react';
import { useEffect, useState } from 'react';
import type { Role } from '../../accounts/contracts';
import { api } from './api';
import { AuthProvider } from './AuthProvider';

function AccountNavigationInner() {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const [role, setRole] = useState<Role | null>(null);

  useEffect(() => {
    let active = true;
    if (isLoaded && isSignedIn) {
      if (window.location.pathname === '/') window.location.assign('/account');
      api<{ account: { role: Role } }>('/api/account')
        .then(({ account }) => { if (active) setRole(account.role); })
        .catch(() => { if (active) setRole(null); });
    } else {
      setRole(null);
    }
    return () => { active = false; };
  }, [isLoaded, isSignedIn]);

  if (!isLoaded) return <span className="account-nav" aria-label="Loading account navigation"><span className="account-skeleton" style={{ width: 84 }} /></span>;
  if (!isSignedIn) return (
    <span className="account-nav">
      <a href="/sign-in">Sign in</a>
      <a className="account-button" href="/sign-up">Create account</a>
    </span>
  );
  return (
    <span className="account-nav">
      {(role === 'editor' || role === 'admin') && <a href="/editor/review">Review</a>}
      {role === 'admin' && <a href="/admin/users">Administration</a>}
      <a href="/account">Account</a>
      <button type="button" onClick={() => signOut({ redirectUrl: '/' })}>Sign out</button>
    </span>
  );
}

export default function AccountNavigation() {
  return <AuthProvider><AccountNavigationInner /></AuthProvider>;
}
