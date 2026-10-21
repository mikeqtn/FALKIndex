import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@clerk/react';
import type { ReviewAction, ReviewDetail, ReviewStatus, ReviewSummary } from '../../accounts/contracts';
import { REVIEW_STATUSES, reviewStatusLabels } from '../../accounts/contracts';
import { api, ApiError, dateLabel, handleAccountError } from './api';
import { AuthProvider } from './AuthProvider';

type Queue = { submissions: ReviewSummary[]; total: number; page: number; pageSize: number; counts: Record<ReviewStatus, number> };
const submitterRoles: Record<string, string> = { brand: 'The brand', watchmaker: 'The watchmaker', reader: 'A reader', other: 'Other' };
const actionLabels: Record<ReviewAction, string> = { approve: 'Accepted', reject: 'Rejected', request_info: 'Requested information' };
const isOpen = (status: ReviewStatus) => status === 'pending' || status === 'needs_info';

function StatusChip({ status }: { status: ReviewStatus }) {
  return <span className={`account-chip review-status ${status}`}>{reviewStatusLabels[status]}</span>;
}

function ReviewConsole() {
  const [status, setStatus] = useState<ReviewStatus>('pending');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const detailRef = useRef<HTMLElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  // Only the latest request may update the screen; a slow earlier response is ignored.
  const queueRequest = useRef(0);
  const detailRequest = useRef(0);
  const selectedRef = useRef<string | null>(null);

  async function loadQueue() {
    const request = ++queueRequest.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ status, search: appliedSearch, page: String(page) });
      const result = await api<Queue>(`/api/review/submissions?${params}`);
      if (request !== queueRequest.current) return;
      // Deciding the last item on a later page empties it; step back to the last page that has items.
      const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
      if (!result.submissions.length && page > lastPage) { setPage(lastPage); return; }
      setQueue(result); setError('');
    } catch (reasonValue) {
      if (request === queueRequest.current) { setQueue(null); setError(handleAccountError(reasonValue)); }
    } finally { if (request === queueRequest.current) setLoading(false); }
  }
  /** Refreshing keeps the current detail on screen; opening another submission clears it. */
  async function loadDetail(id: string) {
    const request = ++detailRequest.current;
    setDetailError('');
    try {
      const result = (await api<{ submission: ReviewDetail }>(`/api/review/submissions/${encodeURIComponent(id)}`)).submission;
      if (request === detailRequest.current) setDetail(result);
    } catch (reasonValue) {
      if (request === detailRequest.current) setDetailError(handleAccountError(reasonValue));
    }
  }
  useEffect(() => { loadQueue(); }, [status, page, appliedSearch]);
  // The decision buttons disappear once a submission is decided; keep focus on the outcome.
  useEffect(() => { if (notice) noticeRef.current?.focus(); }, [notice]);

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (page === 1 && search === appliedSearch) loadQueue();
    setAppliedSearch(search); setPage(1);
  }
  function chooseStatus(next: ReviewStatus) {
    selectedRef.current = null; detailRequest.current++;
    setStatus(next); setPage(1); setSelected(null); setDetail(null); setDetailError(''); setNotice('');
  }
  function select(id: string) {
    selectedRef.current = id;
    setSelected(id); setDetail(null); setNote(''); setError(''); setNotice('');
    detailRef.current?.focus();
    loadDetail(id);
  }
  async function decide(action: ReviewAction) {
    if (!detail) return;
    if (note.trim().length < 10) { setError('Explain your decision in at least 10 characters. The note is kept in the review history.'); return; }
    const id = detail.id;
    setBusy(true); setError(''); setNotice('');
    try {
      await api<{ status: ReviewStatus }>(`/api/review/submissions/${encodeURIComponent(id)}/decisions`, {
        method: 'POST', body: JSON.stringify({ action, expectedStatus: detail.status, note: note.trim() }),
      });
      setNote(''); setNotice(`${actionLabels[action]}. The decision and your note are in the review history.`);
    } catch (reasonValue) {
      setError(handleAccountError(reasonValue));
      // On 409 someone else decided first; the refresh below shows the current state.
      if (!(reasonValue instanceof ApiError && reasonValue.status === 409)) { setBusy(false); return; }
    }
    // The editor may have opened another submission while this one was saving.
    await Promise.all([loadQueue(), selectedRef.current === id ? loadDetail(id) : undefined]);
    setBusy(false);
  }

  const blocked = detail && (detail.selfAuthored || detail.conflicts.length > 0);
  const noReplyChannel = detail?.contact && !detail.contact.email;
  return (
    <div className="account-shell account-wide">
      <header className="account-heading"><div><p className="account-kicker">FALK Index / Editorial</p><h1 className="account-title">Review queue</h1><p className="account-intro">Check each correction against its evidence and record a decision. Every decision needs a note, and the original submission is never changed.</p></div></header>
      <div className="account-stack" style={{ marginTop: 22 }}>
        {error && <div className="account-error" role="alert" tabIndex={-1}>{error}</div>}
        {notice && <div ref={noticeRef} tabIndex={-1} className="account-notice" role="status">{notice}</div>}
        <nav className="review-tabs" aria-label="Review status">
          {REVIEW_STATUSES.map(item => <button key={item} type="button" aria-pressed={status === item} onClick={() => chooseStatus(item)}>{reviewStatusLabels[item]}<span className="review-count">{queue?.counts[item] ?? '–'}</span></button>)}
        </nav>
        <div className="review-layout">
          <section className="account-panel review-queue" aria-label={`${reviewStatusLabels[status]} submissions`}>
            <form className="review-search" onSubmit={applySearch} role="search">
              <div className="account-field"><label htmlFor="review-search">Search submissions</label><input id="review-search" type="search" placeholder="Brand, model or text" value={search} onChange={e => setSearch(e.target.value)} /></div>
              <button className="account-button secondary" type="submit" disabled={loading}>Search</button>
            </form>
            {loading ? <div className="account-loading" role="status"><span className="sr-only">Loading submissions</span><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /></div>
              : queue?.submissions.length ? <ul className="review-list">{queue.submissions.map(item => <li key={item.id}>
                <button type="button" className="review-item" aria-current={selected === item.id ? 'true' : undefined} onClick={() => select(item.id)}>
                  <span className="review-item-head"><strong>{item.subject}</strong><StatusChip status={item.status} /></span>
                  <span className="review-excerpt">{item.excerpt}</span>
                  <span className="account-help">{item.submitter.label} · {dateLabel(item.createdAt)} · {item.evidenceCount} {item.evidenceCount === 1 ? 'link' : 'links'}</span>
                </button></li>)}</ul>
              : queue ? <p className="account-empty">No {reviewStatusLabels[status].toLowerCase()} submissions{appliedSearch ? ' match your search' : ''}.</p>
              : <p className="account-empty">The review queue could not be loaded. <button className="account-button secondary" type="button" onClick={loadQueue}>Retry</button></p>}
            <div className="account-pagination"><span className="account-help">{queue ? `${queue.total} submissions · page ${queue.page}` : ''}</span><div className="account-actions"><button className="account-button secondary" type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => Math.max(1, value - 1))}>Previous</button><button className="account-button secondary" type="button" disabled={!queue || queue.page * queue.pageSize >= queue.total || loading} onClick={() => setPage(value => value + 1)}>Next</button></div></div>
          </section>
          <section className="account-panel account-stack review-detail" ref={detailRef} tabIndex={-1} aria-label="Submission detail">
            {!selected ? <p className="account-empty">Choose a submission to review it.</p>
              : detailError && !detail ? <div className="account-error" role="alert">{detailError} <button className="account-button secondary" type="button" onClick={() => loadDetail(selected)}>Retry</button></div>
              : !detail ? <div className="account-loading" role="status"><span className="sr-only">Loading submission</span><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /></div>
              : <>
                <div className="account-heading"><div><p className="account-kicker">Correction · {dateLabel(detail.createdAt)}</p><h2>{detail.record ? <a href={`/records/${detail.record.id}/`} target="_blank" rel="noreferrer">{detail.record.name}</a> : detail.subject}</h2></div><StatusChip status={detail.status} /></div>
                {detail.selfAuthored && <div className="account-error">You submitted this. Another editor must review it.</div>}
                {detail.conflicts.length > 0 && <div className="account-error">You have a disclosed relationship with {detail.conflicts.join(', ')}. Another editor must review this submission.</div>}
                {detail.staleBase && <div className="account-notice">The record has changed since this was submitted. Check the correction against the current version.</div>}
                <dl className="review-facts">
                  <div><dt>Submitted by</dt><dd>{detail.authorUsername ? <a href={`/people/${detail.authorUsername}`}>{detail.submitter.label}</a> : detail.submitter.label}{detail.submitterRole && <span className="account-help"> · {submitterRoles[detail.submitterRole] ?? detail.submitterRole}</span>}</dd></div>
                  {detail.contact && <div><dt>Private contact</dt><dd>{detail.contact.email ? <a href={`mailto:${encodeURIComponent(detail.contact.email)}`}>{detail.contact.email}</a> : 'None provided'}<span className="account-help"> · for editorial follow-up only, never published</span></dd></div>}
                </dl>
                <div><p className="account-label">What should change, and why</p><blockquote className="review-quote">{detail.explanation}</blockquote></div>
                <div><p className="account-label">Evidence</p>{detail.evidence.length ? <ol className="review-evidence">{detail.evidence.map(url => <li key={url}>{/^https?:\/\//i.test(url) ? <a href={url} target="_blank" rel="noreferrer noopener">{url}</a> : url}</li>)}</ol> : <p className="account-help">No evidence links.</p>}</div>
                {detail.events.length > 0 && <div><p className="account-label">Review history</p><ul className="account-list">{detail.events.map(event => <li key={event.id}><strong>{actionLabels[event.action] ?? event.action}</strong><span className="account-help"> · {event.actor} · {dateLabel(event.createdAt)}</span><p className="review-note">{event.note}</p></li>)}</ul></div>}
                {isOpen(detail.status) && !blocked && <form className="account-stack review-decision" onSubmit={event => event.preventDefault()}>
                  <div className="account-field"><label htmlFor="review-note">Decision note (at least 10 characters)</label><textarea id="review-note" required minLength={10} value={note} onChange={e => setNote(e.target.value)} /><small>Accepting records the decision only. The public record changes when an editor publishes a new profile version.</small></div>
                  <div className="account-actions">
                    <button className="account-button" type="button" disabled={busy} onClick={() => decide('approve')}>Accept</button>
                    <button className="account-button secondary" type="button" disabled={busy || !!noReplyChannel} onClick={() => decide('request_info')}>Request information</button>
                    <button className="account-button danger" type="button" disabled={busy} onClick={() => decide('reject')}>Reject</button>
                  </div>
                  {noReplyChannel && <small className="account-help">This guest left no contact details, so they can't be asked for more information.</small>}
                </form>}
              </>}
          </section>
        </div>
      </div>
    </div>
  );
}

function ReviewSession() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="account-shell"><p role="status">Checking your session…</p></div>;
  if (!isSignedIn) return <div className="account-shell"><h1 className="account-title">Review queue</h1><p>Sign in with an editor account to review submissions.</p><a className="account-button" href="/sign-in?redirect_url=%2Feditor%2Freview">Sign in</a></div>;
  return <ReviewConsole />;
}

export default function EditorReviewApp() {
  return <AuthProvider><ReviewSession /></AuthProvider>;
}
