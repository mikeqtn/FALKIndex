import { useAuth } from '@clerk/react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { conversationWith, inbox } from '../../../server/messages.ts';
import type { Account } from '../../accounts/contracts.ts';
import { AuthProvider } from '../accounts/AuthProvider';
import { api, handleAccountError } from '../accounts/api';
import type { ForumLinks } from '../../lib/forum.ts';
import { forumDay, personInitial } from '../../lib/forum-people';
import { OPEN_MESSAGES } from '../../lib/messages-dock.ts';
import { PostBody } from './PostBody';

type Inbox = Awaited<ReturnType<typeof inbox>>;
type Conversation = Awaited<ReturnType<typeof conversationWith>>;
type Person = Inbox['conversations'][number]['with'];

// How often to look for new messages: often while a conversation is on screen, rarely for the unread count.
const CONVERSATION_POLL = 8_000;
const INBOX_POLL = 45_000;
// Remembered for this tab, so the dock stays open, on the same conversation, from page to page.
const REMEMBERED = 'falk-messages-dock';
type Place = { open: boolean, username: string | null };
const remembered = (): Place => { try { return { open:false, username:null, ...JSON.parse(sessionStorage.getItem(REMEMBERED) ?? 'null') }; } catch { return { open:false, username:null }; } };

const time = (iso: string) => {
  const date = new Date(iso), today = new Date().toDateString() === date.toDateString();
  return today ? new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit' }).format(date) : forumDay(iso);
};

function Face({ person }: { person: Person }) {
  return <span className="forum-avatar f-dm-face" aria-hidden="true">{person.imageUrl ? <img src={person.imageUrl} alt="" /> : personInitial(person.displayName)}</span>;
}

/** While a callback is mounted and the tab is visible, run it every interval ms. */
function usePoll(run: (() => void) | null, interval: number) {
  useEffect(() => {
    if (!run) return;
    const tick = () => { if (document.visibilityState === 'visible') run(); };
    const timer = setInterval(tick, interval);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [run, interval]);
}

function Chat({ username, links, onBack, onRead }: { username: string, links: ForumLinks, onBack: () => void, onRead: () => void }) {
  const [chat, setChat] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const path = `/api/forum/messages/with/${username}`;
  const newest = chat?.messages.at(-1)?.id;

  const load = useCallback(() => api<Conversation>(path).then(setChat).catch(e => setError(handleAccountError(e))), [path]);
  useEffect(() => { setChat(null); setError(''); load(); }, [load]);
  usePoll(load, CONVERSATION_POLL);
  // A message from them arriving while the conversation is on screen has been read.
  useEffect(() => {
    if (!chat?.messages.some(m => !m.mine)) return;
    api(`${path}/read`, { method:'POST', body:'{}' }).then(onRead).catch(() => {});
  }, [newest]);
  useEffect(() => { list.current?.lastElementChild?.scrollIntoView({ block:'end' }); }, [newest]);
  useEffect(() => { field.current?.focus(); }, [username]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const { message } = await api<{ message: Conversation['messages'][number] }>(path, { method:'POST', body:JSON.stringify({ body:draft }) });
      setChat(c => c && { ...c, messages:[...c.messages, message] });
      setDraft('');
    } catch (failure) { setError(handleAccountError(failure)); }
    finally { setBusy(false); field.current?.focus(); }
  };
  const block = async () => {
    if (!chat) return;
    const blocking = !chat.blocked;
    if (blocking && !confirm(`Block @${username}? Neither of you will be able to send messages until you unblock them. They are not told.`)) return;
    try { await api(`${path}/block`, { method:'POST', body:JSON.stringify({ blocked:blocking }) }); await load(); onRead(); }
    catch (failure) { setError(handleAccountError(failure)); }
  };

  const person = chat?.with;
  return <>
    <div className="f-dm-subhead">
      <button className="f-dm-icon" type="button" onClick={onBack} aria-label="All conversations">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
      {person && <>
        <Face person={person} />
        <span className="f-dm-who">
          <strong>{person.displayName}</strong>
          {person.username && <a className="forum-handle" href={`${links.profile}${person.username}/`}>@{person.username}</a>}
        </span>
        <button className="f-dm-text-button" type="button" onClick={block}>{chat.blocked ? 'Unblock' : 'Block'}</button>
      </>}
    </div>
    <div className="f-dm-scroll">
      {!chat && !error && <p className="f-dm-empty" role="status">Loading…</p>}
      {chat && !chat.messages.length && <p className="f-dm-empty">No messages yet. Say hello to {chat.with.displayName}.</p>}
      {chat && chat.messages.length > 0 && <ol className="f-dm-messages" ref={list} aria-label={`Messages with ${chat.with.displayName}`}>
        {chat.messages.map(m => <li key={m.id} className={m.mine ? 'mine' : 'theirs'}>
          <div className="f-dm-bubble"><PostBody text={m.body} /></div>
          <span className="f-dm-time"><span className="sr-only">{m.mine ? 'You, ' : `${chat.with.displayName}, `}</span>{time(m.createdAt)}</span>
        </li>)}
      </ol>}
    </div>
    {error && <div className="account-error f-dm-error" role="alert">{error}</div>}
    {chat?.refusal ? <p className="f-dm-refusal">{chat.refusal}</p>
      : chat && <form className="f-dm-compose" onSubmit={send}>
        <label className="sr-only" htmlFor="f-dm-draft">Message {chat.with.displayName}</label>
        <textarea id="f-dm-draft" ref={field} value={draft} rows={2} maxLength={2000} placeholder={`Message ${chat.with.displayName}`}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <button className="account-button" disabled={busy || !draft.trim()}>Send</button>
      </form>}
  </>;
}

function Conversations({ inbox, error, onOpen }: { inbox: Inbox | null, error: string, onOpen: (username: string) => void }) {
  const [name, setName] = useState('');
  const start = (e: FormEvent) => {
    e.preventDefault();
    const username = name.trim().replace(/^@/, '').toLowerCase();
    if (username) { onOpen(username); setName(''); }
  };
  return <>
    <form className="f-dm-start" onSubmit={start}>
      <label className="sr-only" htmlFor="f-dm-to">Message a member by username</label>
      <input id="f-dm-to" value={name} onChange={e => setName(e.target.value)} placeholder="Message @username" autoComplete="off" spellCheck={false}
        pattern="@?[A-Za-z][A-Za-z0-9_]{2,29}" title="A username: 3 to 30 letters, numbers or underscores" />
      <button className="account-button secondary" disabled={!name.trim()}>Start</button>
    </form>
    <div className="f-dm-scroll">
      {error && <div className="account-error f-dm-error" role="alert">{error}</div>}
      {!inbox && !error && <p className="f-dm-empty" role="status">Loading…</p>}
      {inbox && !inbox.conversations.length && <p className="f-dm-empty">No conversations yet. Choose <strong>Message</strong> beside a member's post, or enter their username above.</p>}
      {inbox && inbox.conversations.length > 0 && <ul className="f-dm-list">{inbox.conversations.map(c => <li key={c.id}>
        <button type="button" className={c.unread ? 'unread' : undefined} disabled={!c.with.username} onClick={() => c.with.username && onOpen(c.with.username)}>
          <Face person={c.with} />
          <span className="f-dm-line">
            <span className="f-dm-line-top"><strong>{c.with.displayName}</strong><span className="f-dm-time">{time(c.last.createdAt)}</span></span>
            <span className="f-dm-preview">{c.blocked ? 'Blocked' : `${c.last.mine ? 'You: ' : ''}${c.last.body}`}</span>
          </span>
          {c.unread && <span className="f-dm-dot"><span className="sr-only">Unread</span></span>}
        </button>
      </li>)}</ul>}
    </div>
  </>;
}

// The chat dock: a bar in the bottom-right corner of every forum page that opens into a panel with the member's
// conversations. It shows only for members who can post (a verified, active account with a username).
function Dock({ links }: { links: ForumLinks }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [ready, setReady] = useState(false);
  const [place, setPlace] = useState(remembered);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [error, setError] = useState('');
  const bar = useRef<HTMLButtonElement>(null);

  const loadInbox = useCallback(() => api<Inbox>('/api/forum/messages').then(i => { setInbox(i); setError(''); }).catch(e => setError(handleAccountError(e))), []);
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    api<{ account: Account }>('/api/account')
      .then(({ account }) => { if (account.onboarded && account.emailVerified && account.status === 'active') { setReady(true); loadInbox(); } })
      .catch(() => {});
  }, [isLoaded, isSignedIn, loadInbox]);
  usePoll(ready ? loadInbox : null, INBOX_POLL);
  useEffect(() => { try { sessionStorage.setItem(REMEMBERED, JSON.stringify(place)); } catch {} }, [place]);
  useEffect(() => {
    const open = (e: Event) => {
      const username = (e as CustomEvent<{ username?: string }>).detail?.username;
      if (username) setPlace({ open:true, username });
    };
    window.addEventListener(OPEN_MESSAGES, open);
    return () => window.removeEventListener(OPEN_MESSAGES, open);
  }, []);

  const toggle = (open: boolean) => {
    setPlace(p => ({ ...p, open }));
    if (open) loadInbox();
    else requestAnimationFrame(() => bar.current?.focus());
  };
  if (!ready) return null;
  const unread = inbox?.unread ?? 0;
  const title = <>Messages{unread > 0 && <span className="f-dm-count">{unread}<span className="sr-only"> unread</span></span>}</>;

  if (!place.open) return <button ref={bar} className="f-dm-bar" type="button" aria-expanded="false" aria-controls="f-dm-panel" onClick={() => toggle(true)}>
    <svg className="f-dm-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>
    <span className="f-dm-title">{title}</span>
    <svg className="f-dm-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
  </button>;

  return <section id="f-dm-panel" className="f-dm-panel" aria-label="Messages" onKeyDown={e => { if (e.key === 'Escape') toggle(false); }}>
    <button className="f-dm-head" type="button" aria-expanded="true" aria-controls="f-dm-panel" onClick={() => toggle(false)}>
      <svg className="f-dm-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>
      <span className="f-dm-title">{title}</span>
      <span className="sr-only">Minimise</span>
      <svg className="f-dm-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    {place.username
      ? <Chat key={place.username} username={place.username} links={links} onRead={loadInbox} onBack={() => { setPlace(p => ({ ...p, username:null })); loadInbox(); }} />
      : <Conversations inbox={inbox} error={error} onOpen={username => setPlace(p => ({ ...p, username }))} />}
  </section>;
}

export default function MessagesDock(props: { links: ForumLinks }) {
  return <AuthProvider><Dock {...props} /></AuthProvider>;
}
