import { useAuth } from '@clerk/react';
import { useCallback, useEffect, useState } from 'react';
import type { listReports } from '../../../server/forum.ts';
import { AuthProvider } from '../accounts/AuthProvider';
import { api, handleAccountError } from '../accounts/api';
import { forumDay } from '../../lib/forum-people';
import type { ForumLinks } from '../../lib/forum.ts';
import { ReasonDialog, type ReasonRequest } from './ReasonDialog';

type Report = Awaited<ReturnType<typeof listReports>>[number];

function Queue({ links, signInHref }: { links: ForumLinks, signInHref: string }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [asking, setAsking] = useState<ReasonRequest | null>(null);
  const load = useCallback(() => api<{ reports: Report[] }>('/api/forum/reports').then(r => setReports(r.reports)).catch(e => setError(handleAccountError(e))), []);
  useEffect(() => { if (isLoaded && isSignedIn) load(); }, [isLoaded, isSignedIn, load]);
  const resolve = (report: Report, resolution: 'hidden' | 'dismissed') => {
    setError(''); setNotice('');
    setAsking({
      title:resolution === 'hidden' ? 'Hide this post' : 'Dismiss this report',
      help:resolution === 'hidden' ? 'Readers will see that a moderator hid it. Your reason goes to the audit log.' : 'The post stays up. Your reason goes to the audit log.',
      action:resolution === 'hidden' ? 'Hide post' : 'Dismiss report',
      run:async reason => {
        await api(`/api/forum/reports/${report.id}/resolution`, { method:'POST', body:JSON.stringify({ resolution, reason }) });
        setNotice(resolution === 'hidden' ? 'The post is hidden and its reports are closed.' : 'The report is dismissed.');
        await load();
      },
    });
  };
  const remove = async (report: Report) => {
    const reason = window.prompt(`This hides all of @${report.author}'s posts and threads and suspends their account. Why?`)?.trim();
    if (!reason) return;
    setError(''); setNotice('');
    try {
      const { posts, threads } = await api<{ posts: number, threads: number }>(`/api/forum/posts/${report.post}/remove-member`, { method:'POST', body:JSON.stringify({ reason }) });
      setNotice(`@${report.author} is suspended. Hid ${posts} ${posts === 1 ? 'post' : 'posts'} and ${threads} ${threads === 1 ? 'thread' : 'threads'}.`);
      await load();
    } catch (e) { setError(handleAccountError(e)); }
  };
  if (isLoaded && !isSignedIn) return <p><a href={signInHref}>Sign in</a> as an editor or administrator.</p>;
  return <div className="account-stack">
    {asking && <ReasonDialog request={asking} onClose={() => setAsking(null)} />}
    {error && <div className="account-error" role="alert">{error}</div>}
    {notice && <div className="account-notice" role="status">{notice}</div>}
    {!reports ? !error && <p className="account-loading" role="status">Loading…</p>
      : reports.length ? <ul className="forum-list">{reports.map(r => <li key={r.id} className="account-panel account-stack">
        <p className="small muted">Reported by {r.reporter ? `@${r.reporter}` : 'a deleted member'} · {forumDay(r.createdAt)} · post by {r.author ? `@${r.author}` : 'a deleted member'}{r.postHidden && ' · already hidden'}</p>
        <p><strong>Reason:</strong> {r.reason}</p>
        <blockquote className="small">{r.excerpt}</blockquote>
        <div className="account-actions">
          <a href={`${links.thread}${r.thread.id}#p-${r.post}`}>Open in {r.thread.title}</a>
          <button className="account-button" type="button" onClick={() => resolve(r, 'hidden')}>Hide post</button>
          <button className="account-button secondary" type="button" onClick={() => resolve(r, 'dismissed')}>Dismiss</button>
          {r.author && <button className="account-button secondary" type="button" onClick={() => remove(r)}>Hide all and suspend</button>}
        </div>
      </li>)}</ul>
      : <p className="account-empty">No open reports.</p>}
  </div>;
}

export default function ModerationApp(props: { links: ForumLinks, signInHref: string }) {
  return <AuthProvider><Queue {...props} /></AuthProvider>;
}
