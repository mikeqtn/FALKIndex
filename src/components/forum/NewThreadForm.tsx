import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Account } from '../../accounts/contracts.ts';
import { AccountCheck } from '../accounts/AccountCheck';
import { api, handleAccountError } from '../accounts/api';
import type { ForumLinks } from '../../lib/forum.ts';
import { useImagePicker } from './ImagePicker';

// Only what the form needs, since the page's HTML carries it.
type Writer = Pick<Account, 'onboarded'>;
interface Props {
  categories: { id: string, name: string }[], category: string,
  record: { id: string, name: string } | null, links: ForumLinks, signInHref: string,
  /** From the server when it knows the reader, so the form is there on first paint. */
  account?: Writer | null,
}

// Without an account from the server (the dev server, or a failed lookup), placeholders show until the browser checks.
export default function NewThreadForm({ categories, category: initial, record, links, signInHref, account: known }: Props) {
  const [account, setAccount] = useState<Writer | null | undefined>(known ?? undefined);
  // A form that replaces placeholders settles in (forum.css .f-enter); one the server sent ready just shows.
  const [late] = useState(known == null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const found = useCallback((found: Account | null, failure?: unknown) => {
    // The server redirects when there's no session cookie; this catches a cookie left over from an expired session.
    if (!found && !failure) { window.location.replace(signInHref); return; }
    if (failure) setError(handleAccountError(failure));
    setAccount(found);
  }, [signInHref]);
  const [category, setCategory] = useState(initial || categories[0]?.id || '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attach = useImagePicker();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const { thread } = await api<{ thread: string }>('/api/forum/threads', { method:'POST', body:JSON.stringify({ category, title, body, ...(record ? { record:record.id } : {}), ...(attach.ids.length ? { images:attach.ids } : {}) }) });
      window.location.assign(`${links.thread}${thread}`);
    } catch (e) { setError(handleAccountError(e)); setBusy(false); }
  };
  if (account === undefined) return <>{mounted && <AccountCheck onAccount={found} />}<FormSkeleton /></>;
  if (!account) return <>{error && <div className="account-error" role="alert">{error}</div>}<p><a href={signInHref}>Sign in</a> with your FALK Index account to start a thread.</p></>;
  if (!account.onboarded) return <p><a href={links.account}>Choose a username</a> on your account page first.</p>;
  return <form className={`account-stack forum-form${late ? ' f-enter' : ''}`} onSubmit={submit}>
    {error && <div className="account-error" role="alert">{error}</div>}
    {record && <p className="small">About <a href={`${links.record}${record.id}/`}>{record.name}</a></p>}
    <div className="account-field"><label htmlFor="forum-category">Category</label>
      <select id="forum-category" value={category} onChange={e => setCategory(e.target.value)}>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
    <div className="account-field"><label htmlFor="forum-title">Title</label>
      <input id="forum-title" value={title} onChange={e => setTitle(e.target.value)} minLength={3} maxLength={150} required /></div>
    <div className="account-field"><label htmlFor="forum-body">Opening post</label>
      <textarea id="forum-body" value={body} onChange={e => setBody(e.target.value)} rows={10} maxLength={20000} required />
      <p className="small muted">Plain text. Leave a blank line between paragraphs; links are made clickable. Cite sources for claims about how a watch is made. Your post is public, and by posting you agree to the <a href={links.terms}>terms of use</a>.</p></div>
    {attach.picker}
    <div className="account-actions"><button className="account-button" disabled={busy || attach.uploading}>Start thread</button></div>
  </form>;
}

/** The form's shape in placeholders (forum.css .f-skel), from the page's first HTML until the account is checked. */
export function FormSkeleton() {
  const field = (control: string) => <div className="account-field"><i className="f-skel f-skel-label" /><i className={`f-skel ${control}`} /></div>;
  return <div className="account-stack forum-form" role="status">
    <span className="sr-only">Loading the form…</span>
    {field('f-skel-field')}
    {field('f-skel-field')}
    {field('f-skel-area')}
    <i className="f-skel f-skel-button" />
  </div>;
}
