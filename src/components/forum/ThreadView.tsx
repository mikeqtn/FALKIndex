import { useAuth } from '@clerk/react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { threadDetail } from '../../../server/forum.ts';
import type { Account } from '../../accounts/contracts.ts';
import { AuthProvider } from '../accounts/AuthProvider';
import { api, dateLabel, handleAccountError } from '../accounts/api';
import type { ForumLinks } from '../../lib/forum.ts';
import { PostBody } from './PostBody';

type Detail = NonNullable<Awaited<ReturnType<typeof threadDetail>>>;
type Post = Detail['posts'][number];
interface Props { detail: Detail, links: ForumLinks, signedIn: boolean, signInHref: string }
interface Tools { account: Account | null, act: (run: () => Promise<unknown>, done?: string) => Promise<boolean>, busy: boolean }

const ask = (question: string) => window.prompt(question)?.trim() || null;

function PostView({ post, links, locked, tools }: { post: Post, links: ForumLinks, locked: boolean, tools?: Tools }) {
  const [editing, setEditing] = useState<string | null>(null);
  const moderator = tools?.account?.role === 'editor' || tools?.account?.role === 'admin';
  const save = (e: FormEvent) => {
    e.preventDefault();
    tools?.act(() => api(`/api/forum/posts/${post.id}`, { method:'PATCH', body:JSON.stringify({ body:editing }) }), 'Your post was updated.').then(ok => { if (ok) setEditing(null); });
  };
  const report = () => { const reason = ask('Why should moderators look at this post?'); if (reason) tools?.act(() => api(`/api/forum/posts/${post.id}/reports`, { method:'POST', body:JSON.stringify({ reason }) }), 'Thanks. Moderators will review this post.'); };
  const toggle = () => { const reason = ask(post.hidden ? 'Why show this post again?' : 'Why hide this post? Readers will see that it was hidden.'); if (reason) tools?.act(() => api(`/api/forum/posts/${post.id}/${post.hidden ? 'show' : 'hide'}`, { method:'POST', body:JSON.stringify({ reason }) })); };
  return <article className={`forum-post${post.hidden ? ' hidden' : ''}`} id={`p-${post.id}`}>
    <header className="small">
      <a href={`${links.profile}${post.author.username}/`}><strong>{post.author.displayName}</strong> <span className="muted">@{post.author.username}</span></a>
      <span className="muted"> · <a href={`#p-${post.id}`}>{dateLabel(post.createdAt)}</a>{post.editedAt && ' · edited'}</span>
    </header>
    {post.body === null ? <p className="muted">A moderator hid this post.</p>
      : editing !== null ? <form className="account-stack" onSubmit={save}>
        <textarea aria-label="Edit your post" value={editing} onChange={e => setEditing(e.target.value)} rows={6} maxLength={20000} required />
        <div className="account-actions"><button className="account-button" disabled={tools?.busy}>Save</button><button className="account-button secondary" type="button" onClick={() => setEditing(null)}>Cancel</button></div>
      </form>
      : <div className="forum-body"><PostBody text={post.body} /></div>}
    {post.hidden && post.hiddenReason && <p className="small muted">Hidden: {post.hiddenReason}</p>}
    {tools?.account && editing === null && <div className="forum-post-actions small">
      {post.own && !post.hidden && !locked && <button type="button" onClick={() => setEditing(post.body)}>Edit</button>}
      {!post.own && !post.hidden && <button type="button" onClick={report}>Report</button>}
      {moderator && <button type="button" onClick={toggle}>{post.hidden ? 'Show' : 'Hide'}</button>}
    </div>}
  </article>;
}

function ThreadBody({ detail, links, tools, signInHref }: { detail: Detail, links: ForumLinks, tools?: Tools, signInHref: string }) {
  const { thread, posts } = detail;
  const [reply, setReply] = useState('');
  const account = tools?.account;
  const moderator = account?.role === 'editor' || account?.role === 'admin';
  const pages = Math.ceil(detail.total / detail.pageSize);
  const send = (e: FormEvent) => {
    e.preventDefault();
    tools?.act(() => api(`/api/forum/threads/${thread.id}/posts`, { method:'POST', body:JSON.stringify({ body:reply }) }), 'Your reply was posted.').then(ok => { if (ok) setReply(''); });
  };
  const moderate = (change: Record<string, boolean>, question: string) => {
    const reason = ask(question);
    if (reason) tools?.act(() => api(`/api/forum/threads/${thread.id}/moderation`, { method:'POST', body:JSON.stringify({ ...change, reason }) }));
  };
  return <>
    <header className="doc-head">
      <div>
        <p className="small muted"><a href={`${links.category}${thread.category}/`}>{thread.categoryName}</a>
          {thread.record && <> · about <a href={`${links.record}${thread.record}/`}>{thread.record}</a></>}
          {thread.pinned && ' · pinned'}{thread.locked && ' · locked'}{thread.hidden && ' · hidden from readers'}</p>
        <h1>{thread.title}</h1>
      </div>
    </header>
    {moderator && <div className="forum-post-actions small" aria-label="Moderation">
      <button type="button" onClick={() => moderate({ pinned:!thread.pinned }, thread.pinned ? 'Why unpin this thread?' : 'Why pin this thread?')}>{thread.pinned ? 'Unpin' : 'Pin'}</button>
      <button type="button" onClick={() => moderate({ locked:!thread.locked }, thread.locked ? 'Why reopen this thread?' : 'Why lock this thread?')}>{thread.locked ? 'Unlock' : 'Lock'}</button>
      <button type="button" onClick={() => moderate({ hidden:!thread.hidden }, thread.hidden ? 'Why show this thread again?' : 'Why hide this thread from readers?')}>{thread.hidden ? 'Show thread' : 'Hide thread'}</button>
      {thread.hidden && thread.hiddenReason && <span className="muted">Hidden: {thread.hiddenReason}</span>}
    </div>}
    <div className="forum-posts">{posts.map(post => <PostView key={post.id} post={post} links={links} locked={thread.locked} tools={tools} />)}</div>
    {pages > 1 && <nav className="account-pagination small" aria-label="Pages">
      {Array.from({ length:pages }, (_, i) => i + 1).map(n => <a key={n} href={`?page=${n}`} aria-current={n === detail.page ? 'page' : undefined}>{n}</a>)}
    </nav>}
    <section className="forum-reply" aria-label="Reply">
      {!account ? <p><a href={signInHref}>Sign in</a> to reply.</p>
        : !account.onboarded ? <p><a href={links.account}>Choose a username</a> to reply.</p>
        : thread.locked && !moderator ? <p className="muted">This thread is locked.</p>
        : <form className="account-stack" onSubmit={send}>
          <label htmlFor="forum-reply">Your reply</label>
          <textarea id="forum-reply" value={reply} onChange={e => setReply(e.target.value)} rows={6} maxLength={20000} required />
          <p className="small muted">Plain text. Leave a blank line between paragraphs; links are made clickable.</p>
          <div className="account-actions"><button className="account-button" disabled={tools?.busy}>Post reply</button></div>
        </form>}
    </section>
  </>;
}

// Signed in: load the account and this reader's view of the thread (their own posts, and for
// moderators the hidden ones), then act through the API and reload after each change.
function Interactive({ detail: initial, links, signInHref }: Props) {
  const { isLoaded, isSignedIn } = useAuth();
  const [detail, setDetail] = useState(initial);
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'notice', text: string } | null>(null);
  const reload = useCallback(() => api<Detail>(`/api/forum/threads/${initial.thread.id}?page=${initial.page}`).then(setDetail), [initial.thread.id, initial.page]);
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    api<{ account: Account }>('/api/account').then(r => setAccount(r.account)).then(reload).catch(() => setAccount(null));
  }, [isLoaded, isSignedIn, reload]);
  // Reports failure as false (with the error shown), so a failed save keeps what the member wrote.
  const act = async (run: () => Promise<unknown>, done?: string) => {
    setBusy(true); setMessage(null);
    try { await run(); await reload(); if (done) setMessage({ kind:'notice', text:done }); return true; }
    catch (error) { setMessage({ kind:'error', text:handleAccountError(error) }); return false; }
    finally { setBusy(false); }
  };
  const tools: Tools = { account, busy, act };
  return <>
    {message && <div className={message.kind === 'error' ? 'account-error' : 'account-notice'} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</div>}
    <ThreadBody detail={detail} links={links} tools={tools} signInHref={signInHref} />
  </>;
}

export default function ThreadView(props: Props) {
  // The server renders the public thread; Clerk only starts in the browser, for readers with a session.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && props.signedIn
    ? <AuthProvider><Interactive {...props} /></AuthProvider>
    : <ThreadBody detail={props.detail} links={props.links} signInHref={props.signInHref} />;
}
