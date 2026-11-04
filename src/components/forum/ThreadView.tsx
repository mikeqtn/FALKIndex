import { useAuth } from '@clerk/react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import type { threadDetail } from '../../../server/forum.ts';
import type { Account } from '../../accounts/contracts.ts';
import { AuthProvider } from '../accounts/AuthProvider';
import { api, handleAccountError } from '../accounts/api';
import type { ForumLinks } from '../../lib/forum.ts';
import { forumDay, personInitial } from '../../lib/forum-people';
import { PostBody } from './PostBody';
import { ReasonDialog, type ReasonRequest } from './ReasonDialog';

type Detail = NonNullable<Awaited<ReturnType<typeof threadDetail>>>;
type Post = Detail['posts'][number];
type Reply = Post & { replies: Reply[] };
interface Props { detail: Detail, links: ForumLinks, signedIn: boolean, signInHref: string }
interface Tools { account: Account | null, act: (run: () => Promise<unknown>, done?: string) => Promise<boolean>, ask: (request: ReasonRequest, done?: string) => void, busy: boolean }
interface Shared { links: ForumLinks, thread: Detail['thread'], tools?: Tools, send: (body: string, parent?: string) => Promise<boolean> | undefined }

/** Conversations start closed from this depth when they have replies, so a large thread stays readable. */
const OPEN_DEPTH = 3;

const isModerator = (tools?: Tools) => tools?.account?.role === 'editor' || tools?.account?.role === 'admin';
const countReplies = (reply: Reply): number => reply.replies.reduce((n, r) => n + 1 + countReplies(r), 0);

/** Posts arrive oldest first, so a parent is always listed before its replies. */
function conversations(posts: Post[]) {
  const replies = new Map(posts.map((p): [string, Reply] => [p.id, { ...p, replies:[] }]));
  const top: Reply[] = [];
  for (const reply of replies.values()) (reply.parentId && replies.get(reply.parentId)?.replies || top).push(reply);
  return top;
}

function Author({ post, links, starter }: { post: Post, links: ForumLinks, starter: boolean }) {
  return <>
    <span className="forum-avatar" aria-hidden="true">
      {post.author.imageUrl ? <img src={post.author.imageUrl} alt="" /> : personInitial(post.author.displayName)}
    </span>
    {post.author.username
      ? <a href={`${links.profile}${post.author.username}/`}><strong>{post.author.displayName}</strong> <span className="forum-handle">@{post.author.username}</span></a>
      : <strong>{post.author.displayName}</strong>}
    {starter && <span className="f-pill quiet" style={{ margin:0 }} title="Started this thread">Author</span>}
    <a href={`#p-${post.id}`}>{forumDay(post.createdAt)}</a>{post.editedAt && <span>Edited</span>}
  </>;
}

// A post's text and what a member can do with it. opening is the thread's first post, which is
// reported as the thread and replied to from the form at the foot of the page.
function PostContent({ post, shared, opening }: { post: Post, shared: Shared, opening: boolean }) {
  const { thread, tools } = shared;
  const [editing, setEditing] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const moderator = isModerator(tools);
  const save = (e: FormEvent) => {
    e.preventDefault();
    tools?.act(() => api(`/api/forum/posts/${post.id}`, { method:'PATCH', body:JSON.stringify({ body:editing }) }), 'Your post was updated.').then(ok => { if (ok) setEditing(null); });
  };
  const answer = (e: FormEvent) => {
    e.preventDefault();
    shared.send(replying ?? '', post.id)?.then(ok => { if (ok) setReplying(null); });
  };
  const report = () => tools?.ask({
    title:opening ? 'Report this thread' : 'Report this post',
    help:'Tell the moderators what is wrong. Only they see your report, and a report can only be made once.',
    action:'Send report',
    run:reason => api(`/api/forum/posts/${post.id}/reports`, { method:'POST', body:JSON.stringify({ reason }) }),
  }, 'Thanks. Moderators will review your report.');
  const toggle = () => tools?.ask({
    title:post.hidden ? 'Show this post again' : 'Hide this post',
    help:post.hidden ? 'Readers will see this post again. Your reason goes to the audit log.' : 'Readers will see that a moderator hid it, and replies to it stay up. Your reason goes to the audit log.',
    action:post.hidden ? 'Show post' : 'Hide post',
    run:reason => api(`/api/forum/posts/${post.id}/${post.hidden ? 'show' : 'hide'}`, { method:'POST', body:JSON.stringify({ reason }) }),
  });
  const canReply = tools?.account?.onboarded && (!thread.locked || moderator) && (!post.hidden || moderator);
  return <>
    {post.body === null ? <p className="forum-hidden-note">A moderator hid this post.</p>
      : editing !== null ? <form className="account-stack" onSubmit={save}>
        <textarea aria-label="Edit your post" value={editing} onChange={e => setEditing(e.target.value)} rows={6} maxLength={20000} required />
        <div className="account-actions"><button className="account-button" disabled={tools?.busy}>Save</button><button className="account-button secondary" type="button" onClick={() => setEditing(null)}>Cancel</button></div>
      </form>
      : <div className="forum-body"><PostBody text={post.body} /></div>}
    {post.hidden && post.hiddenReason && <p className="small muted">Hidden: {post.hiddenReason}</p>}
    {tools?.account && editing === null && replying === null && <div className="forum-post-actions small">
      {canReply && (opening ? <a href="#forum-reply">Reply</a> : <button type="button" onClick={() => setReplying('')}>Reply</button>)}
      {post.own && !post.hidden && !thread.locked && <button type="button" onClick={() => setEditing(post.body)}>Edit</button>}
      {!post.own && !post.hidden && <button type="button" onClick={report}>{opening ? 'Report thread' : 'Report'}</button>}
      {moderator && <button type="button" onClick={toggle}>{post.hidden ? 'Show' : 'Hide'}</button>}
    </div>}
    {replying !== null && <form className="account-stack forum-inline-reply" onSubmit={answer}>
      <textarea aria-label={`Reply to ${post.author.displayName}`} value={replying} onChange={e => setReplying(e.target.value)} rows={4} maxLength={20000} required autoFocus />
      <div className="account-actions"><button className="account-button" disabled={tools?.busy}>Post reply</button><button className="account-button secondary" type="button" onClick={() => setReplying(null)}>Cancel</button></div>
    </form>}
  </>;
}

// A native details element does the collapsing: it needs no script and the browser's find-in-page
// can open it. Its starting state is frozen, so a new reply never folds what someone is reading.
function ReplyNode({ reply, depth, shared }: { reply: Reply, depth: number, shared: Shared }) {
  const [startOpen] = useState(depth < OPEN_DEPTH || reply.replies.length === 0);
  const count = countReplies(reply);
  const fold = (e: MouseEvent<HTMLElement>) => { const details = e.currentTarget.closest('details'); if (details) details.open = false; };
  const starter = !!reply.author.username && reply.author.username === shared.thread.author.username;
  return <li>
    <details className="forum-fold" open={startOpen}>
      <summary className="forum-post-head">
        <Author post={reply} links={shared.links} starter={starter} />
        <span className="forum-fold-label when-open">Collapse</span>
        <span className="forum-fold-label when-closed">{count ? `Expand ${count} ${count === 1 ? 'reply' : 'replies'}` : 'Expand'}</span>
      </summary>
      {/* The line down the side of a conversation: a mouse shortcut for the summary above, which keyboards and screen readers use. */}
      <button className="forum-rail-line" type="button" tabIndex={-1} aria-hidden="true" onClick={fold} />
      <div className={`forum-fold-body${reply.hidden ? ' hidden' : ''}`} id={`p-${reply.id}`}>
        <PostContent post={reply} shared={shared} opening={false} />
      </div>
      {reply.replies.length > 0 && <ol className="forum-replies">
        {reply.replies.map(r => <ReplyNode key={r.id} reply={r} depth={depth + 1} shared={shared} />)}
      </ol>}
    </details>
  </li>;
}

function ThreadBody({ detail, links, tools, signInHref }: { detail: Detail, links: ForumLinks, tools?: Tools, signInHref: string }) {
  const { thread, posts } = detail;
  const [reply, setReply] = useState('');
  const [posted, setPosted] = useState<string | null>(null);
  const categoryHref = `${links.category}${thread.category}/`;
  const [back, setBack] = useState({ href:categoryHref, label:thread.categoryName as string });
  const tree = useRef<HTMLDivElement>(null);
  const account = tools?.account;
  const moderator = isModerator(tools);
  const pages = Math.ceil(detail.total / detail.pageSize);

  // Back goes to the list the reader came from, keeping its sort and page.
  useEffect(() => {
    if (!document.referrer) return;
    const from = new URL(document.referrer);
    if (from.origin !== location.origin) return;
    if (from.pathname === categoryHref) setBack({ href:from.pathname + from.search, label:thread.categoryName });
    if (from.pathname === links.allThreads) setBack({ href:from.pathname + from.search, label:'all threads' });
  }, [categoryHref, links.allThreads, thread.categoryName]);
  // A link to a reply, as in a notification, opens the conversations around it.
  useEffect(() => {
    const target = location.hash && document.getElementById(location.hash.slice(1));
    if (!target) return;
    for (let fold = target.closest('details'); fold; fold = fold.parentElement?.closest('details') ?? null) fold.open = true;
    target.scrollIntoView();
  }, []);
  useEffect(() => { if (posted) document.getElementById(`p-${posted}`)?.scrollIntoView({ block:'center' }); }, [posted, posts]);

  const send = tools && ((body: string, parent?: string) => {
    let id = '';
    return tools.act(async () => { id = (await api<{ post: string }>(`/api/forum/threads/${thread.id}/posts`, { method:'POST', body:JSON.stringify({ body, parent }) })).post; }, 'Your reply was posted.')
      .then(ok => { if (ok) setPosted(id); return ok; });
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send?.(reply)?.then(ok => { if (ok) setReply(''); });
  };
  const moderate = (change: Record<string, boolean>, title: string, action: string) => tools?.ask({
    title, action,
    help:'Your reason goes to the audit log.',
    run:reason => api(`/api/forum/threads/${thread.id}/moderation`, { method:'POST', body:JSON.stringify({ ...change, reason }) }),
  });
  const foldAll = (open: boolean) => tree.current?.querySelectorAll('details').forEach(fold => { fold.open = open; });

  const shared: Shared = { links, thread, tools, send:(body, parent) => send?.(body, parent) };
  const top = conversations(posts);
  const opening = detail.page === 1 ? top.shift() : undefined;
  return <>
    <header className="forum-thread-head">
      <a className="f-back" href={back.href}>Back to {back.label}</a>
      <h1 className="forum-title">{thread.title}</h1>
      {(thread.pinned || thread.locked || thread.hidden) && <p className="forum-flags">
        {thread.pinned && <span className="f-pill">Pinned</span>}
        {thread.locked && <span className="f-pill quiet">Locked</span>}
        {thread.hidden && <span className="f-pill quiet">Hidden from readers</span>}
      </p>}
    </header>
    {moderator && <div className="forum-post-actions forum-moderation" aria-label="Moderation">
      <button type="button" onClick={() => moderate({ pinned:!thread.pinned }, thread.pinned ? 'Unpin this thread' : 'Pin this thread', thread.pinned ? 'Unpin' : 'Pin')}>{thread.pinned ? 'Unpin' : 'Pin'}</button>
      <button type="button" onClick={() => moderate({ locked:!thread.locked }, thread.locked ? 'Reopen this thread' : 'Lock this thread', thread.locked ? 'Unlock' : 'Lock')}>{thread.locked ? 'Unlock' : 'Lock'}</button>
      <button type="button" onClick={() => moderate({ hidden:!thread.hidden }, thread.hidden ? 'Show this thread again' : 'Hide this thread from readers', thread.hidden ? 'Show thread' : 'Hide thread')}>{thread.hidden ? 'Show thread' : 'Hide thread'}</button>
      {thread.hidden && thread.hiddenReason && <span className="muted">Hidden: {thread.hiddenReason}</span>}
    </div>}
    <div className="forum-posts" ref={tree}>
      {opening && <article className={`forum-post${opening.hidden ? ' hidden' : ''}`} id={`p-${opening.id}`}>
        <div className="forum-post-main">
          <header className="forum-post-head"><Author post={opening} links={links} starter /></header>
          <PostContent post={opening} shared={shared} opening />
        </div>
      </article>}
      {top.length > 0 && <>
        <div className="forum-tree-head">
          <h2>{thread.replies} {thread.replies === 1 ? 'reply' : 'replies'}</h2>
          {posts.some(p => p.parentId) && <div className="forum-post-actions">
            <button type="button" onClick={() => foldAll(true)}>Expand all</button>
            <button type="button" onClick={() => foldAll(false)}>Collapse all</button>
          </div>}
        </div>
        <ol className="forum-tree">{top.map(r => <ReplyNode key={r.id} reply={r} depth={0} shared={shared} />)}</ol>
      </>}
    </div>
    {pages > 1 && <nav className="f-pages" aria-label="Pages">
      {Array.from({ length:pages }, (_, i) => i + 1).map(n => <a key={n} href={`?page=${n}`} aria-current={n === detail.page ? 'page' : undefined}>{n}</a>)}
    </nav>}
    <section className="forum-reply" aria-label="Reply">
      {!account ? <p className="forum-reply-prompt"><a href={signInHref}>Sign in</a> with your FALK Index account to reply.</p>
        : !account.onboarded ? <p className="forum-reply-prompt"><a href={links.account}>Choose a username</a> to reply.</p>
        : thread.locked && !moderator ? <p className="forum-reply-prompt">This thread is locked.</p>
        : <form className="account-stack" onSubmit={submit}>
          <label htmlFor="forum-reply">Reply to the thread</label>
          <textarea id="forum-reply" value={reply} onChange={e => setReply(e.target.value)} rows={6} maxLength={20000} required />
          <p className="small muted">Plain text. Leave a blank line between paragraphs; links are made clickable. Your reply is public, and by posting you agree to the <a href={links.terms}>terms of use</a>.</p>
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
  const [asking, setAsking] = useState<ReasonRequest | null>(null);
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
  // The dialog shows a failed request itself, so only a request that went through reaches the page.
  const ask = (request: ReasonRequest, done?: string) => {
    setMessage(null);
    setAsking({ ...request, run:async reason => { await request.run(reason); await reload(); if (done) setMessage({ kind:'notice', text:done }); } });
  };
  const tools: Tools = { account, busy, act, ask };
  return <>
    {message && <div className={`forum-flash ${message.kind === 'error' ? 'account-error' : 'account-notice'}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</div>}
    {asking && <ReasonDialog request={asking} onClose={() => setAsking(null)} />}
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
