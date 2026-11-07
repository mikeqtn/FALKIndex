import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import type { threadDetail } from '../../../server/forum.ts';
import type { Account } from '../../accounts/contracts.ts';
import { AccountCheck } from '../accounts/AccountCheck';
import { api, handleAccountError } from '../accounts/api';
import type { ForumLinks } from '../../lib/forum.ts';
import { forumDay, personInitial } from '../../lib/forum-people';
import { PostBody } from './PostBody';
import { ReasonDialog, type ReasonRequest } from './ReasonDialog';
import { imageUrl, useImagePicker } from './ImagePicker';

type Detail = NonNullable<Awaited<ReturnType<typeof threadDetail>>>;
type Post = Detail['posts'][number];
type Reply = Post & { replies: Reply[] };
// Only what the thread needs, since the page's HTML carries it.
type Reader = Pick<Account, 'role' | 'onboarded'>;
interface Props { detail: Detail, links: ForumLinks, signedIn: boolean, account?: Reader | null, signInHref: string }
interface Tools { account: Reader | null, checking?: boolean, late?: boolean, act: (run: () => Promise<unknown>, done?: string) => Promise<boolean>, ask: (request: ReasonRequest, done?: string) => void, busy: boolean }
interface Shared { links: ForumLinks, thread: Detail['thread'], tools?: Tools, signInHref: string, send: (body: string, parent?: string, images?: string[]) => Promise<boolean> | undefined }

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

// A comment's score. Readers without an account get arrows that lead to sign-in; a member's own
// comment, or one in a locked thread, shows just the number.
function Votes({ post, shared }: { post: Post, shared: Shared }) {
  const { tools, thread, signInHref } = shared;
  const cast = (value: -1 | 1) => tools?.act(() => api(`/api/forum/posts/${post.id}/vote`, { method:'POST', body:JSON.stringify({ value:post.myVote === value ? 0 : value }) }));
  const score = <span className="forum-score">{post.score}<span className="sr-only"> points</span></span>;
  if (!tools) return <span className="forum-votes"><a href={signInHref} aria-label="Sign in to upvote">▲</a>{score}<a href={signInHref} aria-label="Sign in to downvote">▼</a></span>;
  if (!tools.account?.onboarded || post.own || thread.locked) return <span className="forum-votes">{score}</span>;
  return <span className="forum-votes">
    <button type="button" aria-label="Upvote" aria-pressed={post.myVote === 1} onClick={() => cast(1)}>▲</button>
    {score}
    <button type="button" aria-label="Downvote" aria-pressed={post.myVote === -1} onClick={() => cast(-1)}>▼</button>
  </span>;
}

// A post's images. Readers get a note where a moderator hid one; moderators still see it, to review.
function PostImages({ post, tools }: { post: Post, tools?: Tools }) {
  const moderator = isModerator(tools);
  const act = (id: string, path: 'hide' | 'show' | 'purge', title: string, help: string, action: string) => tools?.ask({
    title, help, action, run:reason => api(`/api/forum/images/${id}/${path}`, { method:'POST', body:JSON.stringify({ reason }) }),
  });
  return <div className="forum-images">{post.images.map(image => <figure key={image.id}>
    {image.hidden && !moderator ? <p className="forum-hidden-note">A moderator hid this image.</p>
      : <a href={imageUrl(image.id)} target="_blank" rel="noopener"><img src={imageUrl(image.id)} width={image.width} height={image.height} alt={`Attached by ${post.author.displayName}`} loading="lazy" /></a>}
    {image.hidden && image.hiddenReason && <figcaption className="small muted">Hidden: {image.hiddenReason}</figcaption>}
    {moderator && <div className="forum-post-actions small">
      {image.hidden
        ? <button type="button" onClick={() => act(image.id, 'show', 'Show this image again', 'Readers will see this image again. Your reason goes to the audit log.', 'Show image')}>Show image</button>
        : <button type="button" onClick={() => act(image.id, 'hide', 'Hide this image', 'Readers will see that a moderator hid it. Your reason goes to the audit log.', 'Hide image')}>Hide image</button>}
      {tools?.account?.role === 'admin' && <button type="button" onClick={() => act(image.id, 'purge', 'Delete this image permanently', 'This deletes the file for good and cannot be undone. Use it for material that must not be kept. Your reason goes to the audit log.', 'Delete permanently')}>Delete permanently</button>}
    </div>}
  </figure>)}</div>;
}

// A post's text and what a member can do with it. opening is the thread's first post, which is
// reported as the thread and replied to from the form at the foot of the page.
function PostContent({ post, shared, opening }: { post: Post, shared: Shared, opening: boolean }) {
  const { thread, tools } = shared;
  const [editing, setEditing] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const attach = useImagePicker();
  const revise = useImagePicker();
  const moderator = isModerator(tools);
  // Images a moderator hid stay on the post whatever the edit, so they are left out of the picker.
  const edit = () => {
    revise.reset(post.images.filter(i => !i.hidden).map(i => i.id), post.images.filter(i => i.hidden).length);
    setEditing(post.body);
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    tools?.act(() => api(`/api/forum/posts/${post.id}`, { method:'PATCH', body:JSON.stringify({ body:editing, images:revise.ids }) }), 'Your post was updated.')
      .then(ok => { if (ok) { setEditing(null); revise.clear(); } });
  };
  const answer = (e: FormEvent) => {
    e.preventDefault();
    shared.send(replying ?? '', post.id, attach.ids)?.then(ok => { if (ok) { setReplying(null); attach.clear(); } });
  };
  const report = () => tools?.ask({
    title:opening ? 'Report this thread' : 'Report this post',
    help:'Tell the moderators what is wrong. Only they see your report, and a report can only be made once.',
    action:'Send report',
    run:reason => api(`/api/forum/posts/${post.id}/reports`, { method:'POST', body:JSON.stringify({ reason }) }),
  }, 'Thanks. Moderators will review your report.');
  const del = () => tools?.ask({
    title:'Delete this post?',
    help:'Readers will see that you deleted it, and replies to it stay up. This cannot be undone.',
    action:'Delete post', busyAction:'Deleting…', confirmOnly:true,
    run:() => api(`/api/forum/posts/${post.id}`, { method:'DELETE', body:'{}' }),
  }, 'Your post was deleted.');
  const toggle = () => tools?.ask({
    title:post.hidden ? 'Show this post again' : 'Hide this post',
    help:post.hidden ? 'Readers will see this post again. Your reason goes to the audit log.' : 'Readers will see that a moderator hid it, and replies to it stay up. Your reason goes to the audit log.',
    action:post.hidden ? 'Show post' : 'Hide post',
    run:reason => api(`/api/forum/posts/${post.id}/${post.hidden ? 'show' : 'hide'}`, { method:'POST', body:JSON.stringify({ reason }) }),
  });
  const remove = () => tools?.ask({
    title:`Hide everything by @${post.author.username} and suspend them`,
    help:'This hides all of their posts and threads and suspends their account. Your reason goes to the audit log.',
    action:'Hide all and suspend',
    run:reason => api(`/api/forum/posts/${post.id}/remove-member`, { method:'POST', body:JSON.stringify({ reason }) }),
  }, `@${post.author.username} is suspended and their posts are hidden.`);
  const canReply = tools?.account?.onboarded && (!thread.locked || moderator) && (!post.hidden || moderator);
  const votable = !opening && !post.hidden;
  return <>
    {post.body === null ? <p className="forum-hidden-note">{post.deleted ? 'Its author deleted this post.' : 'A moderator hid this post.'}</p>
      : editing !== null ? <form className="account-stack" onSubmit={save}>
        <textarea aria-label="Edit your post" value={editing} onChange={e => setEditing(e.target.value)} rows={6} maxLength={20000} required />
        {revise.picker}
        <p className="small muted">Images you remove are deleted when you save.</p>
        <div className="account-actions"><button className="account-button" disabled={tools?.busy || revise.uploading}>Save</button><button className="account-button secondary" type="button" onClick={() => { setEditing(null); revise.clear(); }}>Cancel</button></div>
      </form>
      : <div className="forum-body"><PostBody text={post.body} /></div>}
    {post.images.length > 0 && (editing === null || post.images.some(i => i.hidden)) && <PostImages post={editing === null ? post : { ...post, images:post.images.filter(i => i.hidden) }} tools={tools} />}
    {post.hidden && post.hiddenReason && <p className="small muted">Hidden: {post.hiddenReason}</p>}
    {editing === null && replying === null && (tools?.account || votable) && <div className="forum-post-actions small">
      {votable && <Votes post={post} shared={shared} />}
      {tools?.account && <>
        {canReply && (opening ? <a href="#forum-reply">Reply</a> : <button type="button" onClick={() => setReplying('')}>Reply</button>)}
        {post.own && !post.hidden && !thread.locked && <button type="button" onClick={edit}>Edit</button>}
        {post.own && !post.hidden && <button type="button" onClick={del}>Delete</button>}
        {!post.own && !post.hidden && <button type="button" onClick={report}>{opening ? 'Report thread' : 'Report'}</button>}
        {moderator && !post.deleted && <button type="button" onClick={toggle}>{post.hidden ? 'Show' : 'Hide'}</button>}
        {moderator && !post.own && post.author.username && <button type="button" onClick={remove}>Hide all and suspend</button>}
      </>}
    </div>}
    {replying !== null && <form className="account-stack forum-inline-reply" onSubmit={answer}>
      <textarea aria-label={`Reply to ${post.author.displayName}`} value={replying} onChange={e => setReplying(e.target.value)} rows={4} maxLength={20000} required autoFocus />
      {attach.picker}
      <div className="account-actions"><button className="account-button" disabled={tools?.busy || attach.uploading}>Post reply</button><button className="account-button secondary" type="button" onClick={() => setReplying(null)}>Cancel</button></div>
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
  const attach = useImagePicker();
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

  const send = tools && ((body: string, parent?: string, images?: string[]) => {
    let id = '';
    return tools.act(async () => { id = (await api<{ post: string }>(`/api/forum/threads/${thread.id}/posts`, { method:'POST', body:JSON.stringify({ body, parent, ...(images?.length ? { images } : {}) }) })).post; }, 'Your reply was posted.')
      .then(ok => { if (ok) setPosted(id); return ok; });
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send?.(reply, undefined, attach.ids)?.then(ok => { if (ok) { setReply(''); attach.clear(); } });
  };
  const moderate = (change: Record<string, boolean>, title: string, action: string) => tools?.ask({
    title, action,
    help:'Your reason goes to the audit log.',
    run:reason => api(`/api/forum/threads/${thread.id}/moderation`, { method:'POST', body:JSON.stringify({ ...change, reason }) }),
  });
  const foldAll = (open: boolean) => tree.current?.querySelectorAll('details').forEach(fold => { fold.open = open; });

  const shared: Shared = { links, thread, tools, signInHref, send:(body, parent, images) => send?.(body, parent, images) };
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
      {!account && tools?.checking ? <div className="account-loading" aria-hidden="true"><i className="f-skel f-skel-short" /><i className="f-skel f-skel-block" /></div>
        : !account ? <p className="forum-reply-prompt"><a href={signInHref}>Sign in</a> with your FALK Index account to reply.</p>
        : !account.onboarded ? <p className="forum-reply-prompt"><a href={links.account}>Choose a username</a> to reply.</p>
        : thread.locked && !moderator ? <p className="forum-reply-prompt">This thread is locked.</p>
        : <form className={`account-stack${tools?.late ? ' f-enter' : ''}`} onSubmit={submit}>
          <label htmlFor="forum-reply">Reply to the thread</label>
          <textarea id="forum-reply" value={reply} onChange={e => setReply(e.target.value)} rows={6} maxLength={20000} required />
          {attach.picker}
          <p className="small muted">Plain text. Leave a blank line between paragraphs; links are made clickable. Your reply is public, and by posting you agree to the <a href={links.terms}>terms of use</a>.</p>
          <div className="account-actions"><button className="account-button" disabled={tools?.busy || attach.uploading}>Post reply</button></div>
        </form>}
    </section>
  </>;
}

// Signed in: this reader's view of the thread (their own posts, and for moderators the hidden ones), acting through the
// API and reloading after each change. The server usually renders it with the account already; otherwise it is checked
// here, with a placeholder where the reply form goes, so a member never sees "Sign in" first.
function Interactive({ detail: initial, links, signInHref, account: known }: Props) {
  const [detail, setDetail] = useState(initial);
  const [account, setAccount] = useState<Reader | null>(known ?? null);
  const [checking, setChecking] = useState(!known);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'notice', text: string } | null>(null);
  const [asking, setAsking] = useState<ReasonRequest | null>(null);
  const reload = useCallback(() => api<Detail>(`/api/forum/threads/${initial.thread.id}?page=${initial.page}`).then(setDetail), [initial.thread.id, initial.page]);
  const found = useCallback((found: Account | null) => {
    setAccount(found); setChecking(false);
    if (found) reload().catch(() => {});
  }, [reload]);
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
  // The reply form settles in only where it replaces placeholders, not when the server sent it ready.
  const [late] = useState(!known);
  const tools: Tools = { account, checking, late, busy, act, ask };
  return <>
    {mounted && checking && <AccountCheck onAccount={found} />}
    {message && <div className={`forum-flash ${message.kind === 'error' ? 'account-error' : 'account-notice'}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</div>}
    {asking && <ReasonDialog request={asking} onClose={() => setAsking(null)} />}
    <ThreadBody detail={detail} links={links} tools={tools} signInHref={signInHref} />
  </>;
}

export default function ThreadView(props: Props) {
  // Readers with a session get the signed-in view from the server's first render; others the public thread.
  return props.signedIn
    ? <Interactive {...props} />
    : <ThreadBody detail={props.detail} links={props.links} signInHref={props.signInHref} />;
}
