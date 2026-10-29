import { useAuth } from '@clerk/react';
import { useCallback, useEffect, useState } from 'react';
import type { notifications } from '../../../server/forum.ts';
import { AuthProvider } from '../accounts/AuthProvider';
import { api, dateLabel, handleAccountError } from '../accounts/api';
import type { ForumLinks } from '../../lib/forum.ts';

type Inbox = Awaited<ReturnType<typeof notifications>>;

function Inbox({ links, signInHref }: { links: ForumLinks, signInHref: string }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api<Inbox>('/api/forum/notifications').then(setInbox).catch(e => setError(handleAccountError(e))), []);
  useEffect(() => { if (isLoaded && isSignedIn) load(); }, [isLoaded, isSignedIn, load]);
  const readAll = () => api('/api/forum/notifications/read', { method:'POST', body:'{}' }).then(load).catch(e => setError(handleAccountError(e)));
  if (isLoaded && !isSignedIn) return <p><a href={signInHref}>Sign in</a> to see replies to your threads.</p>;
  if (error) return <div className="account-error" role="alert">{error}</div>;
  if (!inbox) return <p className="account-loading" role="status">Loading…</p>;
  return <div className="account-stack">
    <div className="account-actions"><span>{inbox.unread} unread</span>{inbox.unread > 0 && <button className="account-button secondary" type="button" onClick={readAll}>Mark all read</button>}</div>
    {inbox.notifications.length ? <ul className="forum-list">{inbox.notifications.map(n => <li key={n.id} className={n.read ? 'muted' : undefined}>
      <a href={`${links.thread}${n.thread.id}#p-${n.post}`}><strong>{n.author.displayName}</strong> replied in {n.thread.title}</a>
      <span className="small muted"> · {dateLabel(n.createdAt)}</span>
    </li>)}</ul> : <p className="account-empty">No replies yet.</p>}
  </div>;
}

export default function NotificationsApp(props: { links: ForumLinks, signInHref: string }) {
  return <AuthProvider><Inbox {...props} /></AuthProvider>;
}
