import { useEffect, useRef, useState, type FormEvent } from 'react';
import { handleAccountError } from '../accounts/api';

export interface ReasonRequest {
  title: string;
  help: string;
  action: string;
  /** Only confirm, with no reason asked, for a member's own irreversible action such as deleting a post. */
  confirmOnly?: boolean;
  run: (reason: string) => Promise<unknown>;
}

// Asks for the reason behind a report or a moderation decision, or just confirms. A failed request stays open with
// its error and the text kept, so nothing the member wrote is lost.
export function ReasonDialog({ request, onClose }: { request: ReasonRequest, onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await request.run(reason); dialog.current?.close(); }
    catch (failure) { setError(handleAccountError(failure)); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="forum-dialog" aria-labelledby="forum-dialog-title" onClose={onClose}>
    <form className="account-stack" onSubmit={submit}>
      <h2 id="forum-dialog-title">{request.title}</h2>
      <p className="muted">{request.help}</p>
      {error && <div className="account-error" role="alert">{error}</div>}
      {!request.confirmOnly && <>
        <label htmlFor="forum-dialog-reason">Reason</label>
        <textarea id="forum-dialog-reason" value={reason} onChange={e => setReason(e.target.value)} rows={4} minLength={3} maxLength={1000} required autoFocus />
      </>}
      <div className="account-actions">
        <button className={request.confirmOnly ? 'account-button danger' : 'account-button'} disabled={busy}>{request.action}</button>
        <button className="account-button secondary" type="button" autoFocus={request.confirmOnly} onClick={() => dialog.current?.close()}>Cancel</button>
      </div>
    </form>
  </dialog>;
}
