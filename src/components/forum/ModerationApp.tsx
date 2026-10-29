import { useAuth } from '@clerk/react';
import { useCallback, useEffect, useState } from 'react';
import type { listReports } from '../../../server/forum.ts';
import { AuthProvider } from '../accounts/AuthProvider';
import { api, dateLabel, handleAccountError } from '../accounts/api';
import type { ForumLinks } from '../../lib/forum.ts';

type Report = Awaited<ReturnType<typeof listReports>>[number];

function Queue({ links, signInHref }: { links: ForumLinks, signInHref: string }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(() => api<{ reports: Report[] }>('/api/forum/reports').then(r => setReports(r.reports)).catch(e => setError(handleAccountError(e))), []);
  useEffect(() => { if (isLoaded && isSignedIn) load(); }, [isLoaded, isSignedIn, load]);
  const resolve = async (report: Report, resolution: 'hidden' | 'dismissed') => {
    const reason = window.prompt(resolution === 'hidden' ? 'Why hide this post? Readers will see that it was hidden.' : 'Why dismiss this report?')?.trim();
    if (!reason) return;
    setError(''); setNotice('');
    try {
      await api(`/api/forum/reports/${report.id}/resolution`, { method:'POST', body:JSON.stringify({ resolution, reason }) });
      setNotice(resolution === 'hidden' ? 'The post is hidden and its reports are closed.' : 'The report is dismissed.');
      await load();
    } catch (e) { setError(handleAccountError(e)); }
  };
  if (isLoaded && !isSignedIn) return <p><a href={signInHref}>Sign in</a> as an editor or administrator.</p>;
  return <div className="account-stack">
    {error && <div className="account-error" role="alert">{error}</div>}
    {notice && <div className="account-notice" role="status">{notice}</div>}
    {!reports ? !error && <p className="account-loading" role="status">Loading…</p>
      : reports.length ? <ul className="forum-list">{reports.map(r => <li key={r.id} className="account-panel account-stack">
        <p className="small muted">Reported by @{r.reporter} · {dateLabel(r.createdAt)} · post by @{r.author}{r.postHidden && ' · already hidden'}</p>
        <p><strong>Reason:</strong> {r.reason}</p>
        <blockquote className="small">{r.excerpt}</blockquote>
        <div className="account-actions">
          <a href={`${links.thread}${r.thread.id}#p-${r.post}`}>Open in {r.thread.title}</a>
          <button className="account-button" type="button" onClick={() => resolve(r, 'hidden')}>Hide post</button>
          <button className="account-button secondary" type="button" onClick={() => resolve(r, 'dismissed')}>Dismiss</button>
        </div>
      </li>)}</ul>
      : <p className="account-empty">No open reports.</p>}
  </div>;
}

export default function ModerationApp(props: { links: ForumLinks, signInHref: string }) {
  return <AuthProvider><Queue {...props} /></AuthProvider>;
}
