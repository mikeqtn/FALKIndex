import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/react';
import type { MyContribution, ReviewAction, ReviewStatus } from '../../accounts/contracts';
import { reviewStatusLabels } from '../../accounts/contracts';
import { api, dateLabel, handleAccountError } from './api';
import { AuthProvider } from './AuthProvider';

const actionLabels: Record<ReviewAction, string> = { approve: 'Accepted', reject: 'Rejected', request_info: 'An editor asked for more information' };
const kindLabels = { correction: 'Correction', new_watch: 'New watch' };
// What each state means for the author, in their terms.
const statusHelp: Record<ReviewStatus, string> = {
  pending: 'Waiting for an editor.',
  needs_info: 'An editor needs more from you before deciding. Reply through the help page, quoting the watch and the date you sent it.',
  approved: '',
  rejected: '',
  withdrawn: 'You withdrew this.',
};
const acceptedHelp = (c: MyContribution) => c.kind === 'new_watch'
  ? 'Published as a new record. Scores are added in later reviewed versions.'
  : 'Accepted. The record changes when an editor publishes a new version.';

function Contribution({ c }: { c: MyContribution }) {
  const help = c.status === 'approved' ? acceptedHelp(c) : statusHelp[c.status];
  return (
    <li className="account-panel account-stack">
      <div className="account-heading">
        <div><p className="account-kicker">{kindLabels[c.kind]} · sent {dateLabel(c.createdAt)}</p>
          <h2>{c.record ? <a href={c.record.url}>{c.subject}</a> : c.subject}</h2></div>
        <span className={`account-chip review-status ${c.status}`}>{reviewStatusLabels[c.status]}</span>
      </div>
      {help && <p className="account-help">{help}{c.status === 'needs_info' && <> <a href="/help/">Help page</a></>}</p>}
      {c.events.length > 0 && <div><p className="account-label">Editor feedback</p><ul className="account-list">{c.events.map(e => <li key={e.id}>
        <strong>{actionLabels[e.action] ?? e.action}</strong><span className="account-help"> · {dateLabel(e.createdAt)}</span>
        <p className="review-note">{e.note}</p></li>)}</ul></div>}
      <details><summary>What you sent</summary>
        <blockquote className="review-quote">{c.explanation}</blockquote>
        {c.evidence.length > 0 && <ol className="review-evidence">{c.evidence.map(url => <li key={url}>
          {/^https?:\/\//i.test(url) ? <a href={url} target="_blank" rel="noreferrer noopener">{url}</a> : url}</li>)}</ol>}
      </details>
    </li>
  );
}

function Contributions() {
  const [list, setList] = useState<MyContribution[] | null>(null);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    api<{ contributions: MyContribution[] }>('/api/account/contributions')
      .then(r => setList(r.contributions)).catch(e => setError(handleAccountError(e)));
  };
  useEffect(load, []);
  return (
    <div className="account-shell">
      <header className="account-heading"><div><p className="account-kicker">FALK Index / Your account</p>
        <h1 className="account-title">My contributions</h1>
        <p className="account-intro">Corrections and new watches you have sent, what editors decided, and their notes to you.</p></div></header>
      <div className="account-stack" style={{ marginTop: 22 }}>
        {error ? <div className="account-error" role="alert">{error} <button className="account-button secondary" type="button" onClick={load}>Try again</button></div>
          : !list ? <div className="account-panel account-loading" role="status"><span className="sr-only">Loading contributions</span><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /></div>
          : list.length ? <ul className="account-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{list.map(c => <Contribution key={c.id} c={c} />)}</ul>
          : <div className="account-panel account-stack"><p className="account-empty">You haven't sent anything yet.</p>
            <p><a href="/records/new/">Propose a new watch</a> or <a href="/corrections/">correct a record</a>.</p></div>}
      </div>
    </div>
  );
}

function Session() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="account-shell"><p role="status">Checking your session…</p></div>;
  if (!isSignedIn) return <div className="account-shell"><h1 className="account-title">My contributions</h1><p>Sign in to see what you have sent and the feedback on it.</p>
    <a className="account-button" href="/sign-in?redirect_url=%2Faccount%2Fcontributions%2F">Sign in</a></div>;
  return <Contributions />;
}

export default function MyContributionsApp() {
  return <AuthProvider><Session /></AuthProvider>;
}
