import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@clerk/react';
import type { MyContribution, ReviewEventAction, ReviewStatus } from '../../accounts/contracts';
import { replyInput, reviewStatusLabels } from '../../accounts/contracts';
import { api, dateLabel, handleAccountError } from './api';
import { AuthProvider } from './AuthProvider';

const actionLabels: Record<ReviewEventAction, string> = { approve: 'Accepted', reject: 'Rejected', request_info: 'An editor asked for more information', reply: 'You replied' };
const kindLabels = { correction: 'Correction', new_watch: 'New watch' };
// What each state means for the author, in their terms.
const statusHelp: Record<ReviewStatus, string> = {
  pending: 'Waiting for an editor.',
  needs_info: 'An editor needs more from you before deciding. Answer their note below.',
  approved: '',
  rejected: '',
  withdrawn: 'You withdrew this.',
};
const acceptedHelp = (c: MyContribution) => c.kind === 'new_watch'
  ? 'Published as a new record. Scores are added in later reviewed versions.'
  : 'Accepted. The record changes when an editor publishes a new version.';

/** The author's answer to a request for information. It cannot be edited after sending. */
function Reply({ id, onSent }: { id: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const [links, setLinks] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = replyInput.safeParse({ text, evidence: links.split(/\s+/).filter(Boolean) });
    if (!parsed.success) { setError(parsed.error.issues.map(i => i.path[0] === 'evidence' ? `Source links: ${i.message}` : i.message).join(' ')); return; }
    setBusy(true); setError('');
    try { await api(`/api/account/contributions/${id}/replies`, { method: 'POST', body: JSON.stringify(parsed.data) }); onSent(); }
    catch (e) { setError(handleAccountError(e)); setBusy(false); }
  };
  return (
    <form className="account-stack" onSubmit={send} noValidate>
      {error && <div className="account-error" role="alert">{error}</div>}
      <div className="account-field"><label htmlFor={`reply-${id}`}>Your reply</label>
        <textarea id={`reply-${id}`} required minLength={10} maxLength={5000} value={text} onChange={e => setText(e.target.value)} /></div>
      <div className="account-field"><label htmlFor={`reply-links-${id}`}>Extra source links <span className="muted">(optional, one per line)</span></label>
        <textarea id={`reply-links-${id}`} rows={2} value={links} onChange={e => setLinks(e.target.value)} placeholder="https://" />
        <small>Your reply goes back to the editors and becomes part of this submission's history. It can't be edited afterwards.</small></div>
      <div className="account-actions"><button className="account-button" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send reply'}</button></div>
    </form>
  );
}

function Contribution({ c, onChange }: { c: MyContribution; onChange: () => void }) {
  const help = c.status === 'approved' ? acceptedHelp(c) : statusHelp[c.status];
  return (
    <li className="account-panel account-stack">
      <div className="account-heading">
        <div><p className="account-kicker">{kindLabels[c.kind]} · sent {dateLabel(c.createdAt)}</p>
          <h2>{c.record ? <a href={c.record.url}>{c.subject}</a> : c.subject}</h2></div>
        <span className={`account-chip review-status ${c.status}`}>{reviewStatusLabels[c.status]}</span>
      </div>
      {help && <p className="account-help">{help}</p>}
      {c.events.length > 0 && <div><p className="account-label">Editor feedback</p><ul className="account-list">{c.events.map(e => <li key={e.id}>
        <strong>{actionLabels[e.action] ?? e.action}</strong><span className="account-help"> · {dateLabel(e.createdAt)}</span>
        <p className="review-note">{e.note}</p>
        {e.evidence.length > 0 && <ol className="review-evidence">{e.evidence.map(url => <li key={url}><a href={url} target="_blank" rel="noreferrer noopener">{url}</a></li>)}</ol>}</li>)}</ul></div>}
      {c.status === 'needs_info' && <Reply id={c.id} onSent={onChange} />}
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
          : list.length ? <ul className="account-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{list.map(c => <Contribution key={c.id} c={c} onChange={load} />)}</ul>
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
