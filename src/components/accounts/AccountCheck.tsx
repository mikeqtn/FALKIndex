import { useAuth } from '@clerk/react';
import { useEffect } from 'react';
import type { Account } from '../../accounts/contracts.ts';
import { AuthProvider } from './AuthProvider';
import { api } from './api';

/**
 * Asks Clerk, then the API, who is reading, for a page the server rendered without knowing (the dev server, or a failed
 * lookup). Calls back with the account, or null: with the error if the API refused, without one if signed out.
 */
function Check({ onAccount }: { onAccount: (account: Account | null, failure?: unknown) => void }) {
  const { isLoaded, isSignedIn } = useAuth();
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { onAccount(null); return; }
    api<{ account: Account }>('/api/account').then(r => onAccount(r.account), failure => onAccount(null, failure ?? new Error('Unknown')));
  }, [isLoaded, isSignedIn, onAccount]);
  return null;
}

/** Mount only in the browser: Clerk does not run on the server. */
export function AccountCheck(props: { onAccount: (account: Account | null, failure?: unknown) => void }) {
  return <AuthProvider><Check {...props} /></AuthProvider>;
}
