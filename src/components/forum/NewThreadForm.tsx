import { useAuth } from '@clerk/react';
import { useEffect, useState, type FormEvent } from 'react';
import type { Account } from '../../accounts/contracts.ts';
import { AuthProvider } from '../accounts/AuthProvider';
import { api, handleAccountError } from '../accounts/api';
import type { ForumLinks } from '../../lib/forum.ts';

interface Props {
  categories: { id: string, name: string }[], category: string,
  record: { id: string, name: string } | null, links: ForumLinks, signInHref: string,
}

function Form({ categories, category: initial, record, links, signInHref }: Props) {
  const { isLoaded, isSignedIn } = useAuth();
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [category, setCategory] = useState(initial || categories[0]?.id || '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { setAccount(null); return; }
    api<{ account: Account }>('/api/account').then(r => setAccount(r.account)).catch(e => { setError(handleAccountError(e)); setAccount(null); });
  }, [isLoaded, isSignedIn]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const { thread } = await api<{ thread: string }>('/api/forum/threads', { method:'POST', body:JSON.stringify({ category, title, body, ...(record ? { record:record.id } : {}) }) });
      window.location.assign(`${links.thread}${thread}`);
    } catch (e) { setError(handleAccountError(e)); setBusy(false); }
  };
  if (account === undefined) return <p className="account-loading" role="status">Loading…</p>;
  if (!account) return <p><a href={signInHref}>Sign in</a> with your FALK Index account to start a thread.</p>;
  if (!account.onboarded) return <p><a href={links.account}>Choose a username</a> on your account page first.</p>;
  return <form className="account-stack forum-form" onSubmit={submit}>
    {error && <div className="account-error" role="alert">{error}</div>}
    {record && <p className="small">About <a href={`${links.record}${record.id}/`}>{record.name}</a></p>}
    <div className="account-field"><label htmlFor="forum-category">Category</label>
      <select id="forum-category" value={category} onChange={e => setCategory(e.target.value)}>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
    <div className="account-field"><label htmlFor="forum-title">Title</label>
      <input id="forum-title" value={title} onChange={e => setTitle(e.target.value)} minLength={3} maxLength={150} required /></div>
    <div className="account-field"><label htmlFor="forum-body">Opening post</label>
      <textarea id="forum-body" value={body} onChange={e => setBody(e.target.value)} rows={10} maxLength={20000} required />
      <p className="small muted">Plain text. Leave a blank line between paragraphs; links are made clickable. Cite sources for claims about how a watch is made.</p></div>
    <div className="account-actions"><button className="account-button" disabled={busy}>Start thread</button></div>
  </form>;
}

export default function NewThreadForm(props: Props) {
  return <AuthProvider><Form {...props} /></AuthProvider>;
}
