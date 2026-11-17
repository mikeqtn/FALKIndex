import { useAuth } from '@clerk/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import type { conversationWith, inbox, suggestPeople } from '../../../server/messages.ts';
import type { Account } from '../../accounts/contracts.ts';
import { AuthProvider } from '../accounts/AuthProvider';
import { api, handleAccountError } from '../accounts/api';
import type { ForumLinks } from '../../lib/forum.ts';
import { forumDay, personInitial } from '../../lib/forum-people';
import { OPEN_MESSAGES } from '../../lib/messages-dock.ts';
import { IMAGE_TYPES, imageUrl, uploadError, uploadImage } from './ImagePicker';
import { Lightbox, openInLightbox } from './Lightbox';
import { PostBody } from './PostBody';

type Inbox = Awaited<ReturnType<typeof inbox>>;
type Conversation = Awaited<ReturnType<typeof conversationWith>>;
type Message = Conversation['messages'][number];
type Person = Inbox['conversations'][number]['with'];

// How often to look for new messages: often while a conversation is on screen, rarely for the unread count.
const CONVERSATION_POLL = 8_000;
const INBOX_POLL = 45_000;
/** While the conversation list is on screen, so a new message moves its conversation to the top soon after it arrives. */
const LIST_POLL = 10_000;
/** As in messageInput on the server. */
const MAX_IMAGES = 4;
/** How long the panel takes to fold away; forum.css animates .f-dm-panel.closing for the same time. */
const CLOSE_MS = 200;
// Remembered for this tab, so the dock stays open, on the same conversation, from page to page. eligible remembers a
// member who cannot message, so later pages do not show them a placeholder bar.
const REMEMBERED = 'falk-messages-dock';
type Place = { open: boolean, username: string | null, eligible?: boolean };
const remembered = (): Place => { try { return { open:false, username:null, ...JSON.parse(sessionStorage.getItem(REMEMBERED) ?? 'null') }; } catch { return { open:false, username:null }; } };
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const time = (iso: string) => {
  const date = new Date(iso), today = new Date().toDateString() === date.toDateString();
  return today ? new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit' }).format(date) : forumDay(iso);
};

function Face({ person }: { person: Person }) {
  return <span className="forum-avatar f-dm-face" aria-hidden="true">{person.imageUrl ? <img src={person.imageUrl} alt="" /> : personInitial(person.displayName)}</span>;
}

/** Placeholder shapes in the place of what is loading, so the panel keeps its size. */
function ListSkeleton() {
  return <ul className="f-dm-list f-dm-skeleton" aria-hidden="true">{[70, 55, 80, 60].map((width, i) => <li key={i}><span className="f-dm-skel-row">
    <span className="f-skel f-skel-avatar f-dm-face" />
    <span className="f-dm-line"><span className="f-skel" style={{ width:`${width - 25}%` }} /><span className="f-skel f-dm-skel-thin" style={{ width:`${width}%` }} /></span>
  </span></li>)}</ul>;
}
function ChatSkeleton() {
  return <ol className="f-dm-messages f-dm-skeleton" aria-hidden="true">{[['theirs', 190], ['theirs', 120], ['mine', 210], ['theirs', 160], ['mine', 100]].map(([side, width], i) =>
    <li key={i} className={side as string}><span className="f-skel f-dm-skel-bubble" style={{ width }} /></li>)}</ol>;
}
function BarSkeleton() {
  return <div className="f-dm-bar f-dm-bar-skeleton" aria-hidden="true"><span className="f-skel f-dm-skel-glyph" /><span className="f-skel f-dm-skel-title" /></div>;
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

function Bubble({ message, editing, onEdit, onDelete, onSave, onCancel }: {
  message: Message, editing: boolean, onEdit: () => void, onDelete: () => Promise<void>, onSave: (body: string) => Promise<boolean>, onCancel: () => void,
}) {
  const [draft, setDraft] = useState(message.body ?? '');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  useEffect(() => { if (editing) setDraft(message.body ?? ''); }, [editing]);
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try { if (await onSave(draft)) onCancel(); } finally { setBusy(false); }
  };
  if (message.deleted) return <div className="f-dm-bubble deleted">Message deleted</div>;
  if (editing) return <form className="f-dm-edit" onSubmit={save}>
    <label className="sr-only" htmlFor={`f-dm-edit-${message.id}`}>Edit your message</label>
    <textarea id={`f-dm-edit-${message.id}`} value={draft} rows={2} maxLength={2000} autoFocus onChange={e => setDraft(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
        else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save(); }
      }} />
    <span className="f-dm-actions"><button type="submit" disabled={busy}>Save</button><button type="button" onClick={onCancel}>Cancel</button></span>
  </form>;
  return <>
    <div className="f-dm-bubble">
      {message.images.length > 0 && <span className={`f-dm-images n${Math.min(message.images.length, 4)}`}>{message.images.map((image, i) =>
        <a key={image.id} href={imageUrl(image.id)} target="_blank" rel="noopener" aria-haspopup="dialog" onClick={openInLightbox(() => setViewing(i))}><img src={imageUrl(image.id, 'thumb')} width={image.width} height={image.height} alt="Sent image" loading="lazy" /></a>)}</span>}
      {message.body && <PostBody text={message.body} />}
    </div>
    {viewing !== null && <Lightbox images={message.images} start={viewing} alt="Sent image" preview onClose={() => setViewing(null)} />}
    {message.mine && (confirming
      ? <span className="f-dm-actions confirm" role="group" aria-label="Delete this message">
          <span>Delete for both of you?</span>
          <button type="button" className="danger" disabled={busy} onClick={async () => { setBusy(true); try { await onDelete(); } finally { setBusy(false); } }}>Delete</button>
          <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
        </span>
      : <span className="f-dm-actions own"><button type="button" onClick={onEdit}>Edit</button><button type="button" onClick={() => setConfirming(true)}>Delete</button></span>)}
  </>;
}

/** Asks before blocking someone or deleting the conversation, over the top of it. Cancel has focus, so neither is ever one keypress. */
function ConfirmBanner({ title, text, action, doing, busy, onConfirm, onCancel }: {
  title: string, text: string, action: string, doing: string, busy: boolean, onConfirm: () => void, onCancel: () => void,
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return <div className="f-dm-banner" role="alertdialog" aria-labelledby="f-dm-banner-title" aria-describedby="f-dm-banner-text"
    onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
    <p id="f-dm-banner-title" className="f-dm-banner-title">{title}</p>
    <p id="f-dm-banner-text">{text}</p>
    <span className="f-dm-banner-actions">
      <button className="account-button" type="button" disabled={busy} onClick={onConfirm}>{busy ? doing : action}</button>
      <button ref={cancel} className="account-button secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    </span>
  </div>;
}

function Chat({ username, links, onBack, onRead }: { username: string, links: ForumLinks, onBack: () => void, onRead: () => void }) {
  const [chat, setChat] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState('');
  const [attached, setAttached] = useState<{ id: string, width: number, height: number }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Older pages, loaded on request and kept while the newest page is polled; earlierMore is whether more lie beyond.
  const [earlier, setEarlier] = useState<Message[]>([]);
  const [earlierMore, setEarlierMore] = useState<boolean | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const keepFromBottom = useRef<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const path = `/api/forum/messages/with/${username}`;
  const newest = chat?.messages.at(-1)?.id;
  const latestIds = new Set(chat?.messages.map(m => m.id));
  const shown = [...earlier.filter(m => !latestIds.has(m.id)), ...(chat?.messages ?? [])];
  const more = earlierMore ?? chat?.more ?? false;

  const load = useCallback(() => api<Conversation>(path).then(setChat).catch(e => setError(handleAccountError(e))), [path]);
  useEffect(() => { setChat(null); setError(''); load(); }, [load]);
  usePoll(load, CONVERSATION_POLL);
  // A message from them arriving while the conversation is on screen has been read.
  useEffect(() => {
    if (!chat?.messages.some(m => !m.mine)) return;
    api(`${path}/read`, { method:'POST', body:'{}' }).then(onRead).catch(() => {});
  }, [newest]);
  useEffect(() => { list.current?.lastElementChild?.scrollIntoView({ block:'end' }); }, [newest]);
  // Older messages go in above what the member is reading, so keep their place measured from the bottom.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && keepFromBottom.current !== null) { box.scrollTop = box.scrollHeight - keepFromBottom.current; keepFromBottom.current = null; }
  }, [earlier]);
  const loadEarlier = async () => {
    const oldest = shown[0]?.id;
    if (!oldest || loadingEarlier) return;
    setLoadingEarlier(true); setError('');
    try {
      const page = await api<Conversation>(`${path}?before=${oldest}`);
      const box = scroller.current;
      if (box) keepFromBottom.current = box.scrollHeight - box.scrollTop;
      setEarlier(current => [...page.messages, ...current]);
      setEarlierMore(page.more);
    } catch (failure) { setError(handleAccountError(failure)); }
    finally { setLoadingEarlier(false); }
  };
  useEffect(() => { field.current?.focus(); }, [username]);
  // The message box starts one line high and grows with what is written, up to its max-height in forum.css.
  useEffect(() => {
    const box = field.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }, [draft, chat?.refusal]);

  const replace = (message: Message) => {
    setChat(c => c && { ...c, messages:c.messages.map(m => m.id === message.id ? message : m) });
    setEarlier(current => current.map(m => m.id === message.id ? message : m));
  };
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if ((!draft.trim() && !attached.length) || busy || uploading) return;
    setBusy(true); setError('');
    try {
      const { message } = await api<{ message: Message }>(path, { method:'POST', body:JSON.stringify({ body:draft, ...(attached.length ? { images:attached.map(i => i.id) } : {}) }) });
      setChat(c => c && { ...c, messages:[...c.messages, message] });
      setDraft(''); setAttached([]);
    } catch (failure) { setError(handleAccountError(failure)); }
    finally { setBusy(false); field.current?.focus(); }
  };
  const attach = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    setError(''); setUploading(true);
    try {
      let count = attached.length;
      for (const file of files) {
        if (count >= MAX_IMAGES) throw new Error(`A message can have up to ${MAX_IMAGES} images.`);
        const image = await uploadImage(file);
        setAttached(current => [...current, image]);
        count++;
      }
    } catch (failure) { setError(uploadError(failure)); }
    finally { setUploading(false); }
  };
  const save = async (id: string, body: string) => {
    setError('');
    try { replace((await api<{ message: Message }>(`/api/forum/messages/${id}`, { method:'PATCH', body:JSON.stringify({ body }) })).message); return true; }
    catch (failure) { setError(handleAccountError(failure)); return false; }
  };
  const remove = async (id: string) => {
    setError('');
    try {
      await api(`/api/forum/messages/${id}`, { method:'DELETE', body:'{}' });
      // The newest page reloads below; an older one is not polled, so mark it here.
      setEarlier(current => current.map(m => m.id === id ? { ...m, deleted:true, body:null, images:[] } : m));
      await load(); onRead();
    }
    catch (failure) { setError(handleAccountError(failure)); }
  };
  // Blocking asks first, in a banner over the conversation; unblocking needs no asking.
  const [askingBlock, setAskingBlock] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const setBlock = async (blocked: boolean) => {
    setBlocking(true); setError('');
    try { await api(`${path}/block`, { method:'POST', body:JSON.stringify({ blocked }) }); setAskingBlock(false); await load(); onRead(); }
    catch (failure) { setError(handleAccountError(failure)); }
    finally { setBlocking(false); }
  };

  const person = chat?.with;
  const name = person ? (person.username ? `@${person.username}` : person.displayName) : '';
  return <>
    <div className="f-dm-subhead">
      <button className="f-dm-icon" type="button" onClick={onBack} aria-label="All conversations">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
      {person ? <>
        <Face person={person} />
        <span className="f-dm-who">
          <strong>{person.displayName}</strong>
          {person.username && <a className="forum-handle" href={`${links.profile}${person.username}/`}>@{person.username}</a>}
        </span>
        <button className="f-dm-text-button" type="button" aria-expanded={chat.blocked ? undefined : askingBlock} disabled={blocking}
          onClick={() => chat.blocked ? setBlock(false) : setAskingBlock(now => !now)}>{chat.blocked ? 'Unblock' : 'Block'}</button>
      </> : !error && <span className="f-dm-skel-row" aria-hidden="true"><span className="f-skel f-skel-avatar f-dm-face" /><span className="f-skel" style={{ width:120 }} /></span>}
    </div>
    {askingBlock && person && !chat.blocked && <ConfirmBanner title={`Block ${name}?`}
      text="Neither of you will be able to send messages until you unblock them. They are not told, and what you have already said stays here."
      action="Block" doing="Blocking…" busy={blocking} onConfirm={() => setBlock(true)} onCancel={() => setAskingBlock(false)} />}
    <div className="f-dm-scroll" ref={scroller} aria-busy={!chat}>
      {!chat && !error && <><span className="sr-only" role="status">Loading messages</span><ChatSkeleton /></>}
      {chat && !shown.length && <p className="f-dm-empty">No messages yet. Say hello to {chat.with.displayName}.</p>}
      {chat && more && <button className="f-dm-earlier" type="button" disabled={loadingEarlier} onClick={loadEarlier}>{loadingEarlier ? 'Loading…' : 'Load earlier messages'}</button>}
      {chat && shown.length > 0 && <ol className="f-dm-messages" ref={list} aria-label={`Messages with ${chat.with.displayName}`}>
        {shown.map(m => <li key={m.id} className={m.mine ? 'mine' : 'theirs'}>
          <Bubble message={m} editing={editing === m.id} onEdit={() => setEditing(m.id)} onCancel={() => setEditing(null)}
            onSave={body => save(m.id, body)} onDelete={() => remove(m.id)} />
          <span className="f-dm-time"><span className="sr-only">{m.mine ? 'You, ' : `${chat.with.displayName}, `}</span>{time(m.createdAt)}{m.editedAt && !m.deleted && ' · Edited'}</span>
        </li>)}
      </ol>}
    </div>
    {error && <div className="account-error f-dm-error" role="alert">{error}</div>}
    {chat?.refusal ? <p className="f-dm-refusal">{chat.refusal}</p>
      : chat && <form className="f-dm-compose" onSubmit={send}>
        {(attached.length > 0 || uploading) && <ul className="f-dm-attached" aria-label="Images to send">
          {attached.map(image => <li key={image.id}>
            <img src={imageUrl(image.id, 'thumb')} alt="Image to send" />
            <button type="button" aria-label="Remove image" onClick={() => setAttached(current => current.filter(i => i.id !== image.id))}>×</button>
          </li>)}
          {uploading && <li><span className="f-skel f-dm-skel-thumb" /><span className="sr-only" role="status">Uploading</span></li>}
        </ul>}
        <label className="sr-only" htmlFor="f-dm-draft">Message {chat.with.displayName}</label>
        <textarea id="f-dm-draft" ref={field} value={draft} rows={1} maxLength={2000} placeholder={`Message ${chat.with.displayName}`}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <label className={`f-dm-icon f-dm-attach${attached.length >= MAX_IMAGES || uploading ? ' disabled' : ''}`} title={`Add images (up to ${MAX_IMAGES})`}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-9 8" /></svg>
          <span className="sr-only">Add images</span>
          <input className="sr-only" type="file" accept={IMAGE_TYPES.join(',')} multiple disabled={attached.length >= MAX_IMAGES || uploading} onChange={attach} />
        </label>
        <button className="account-button" disabled={busy || uploading || (!draft.trim() && !attached.length)}>Send</button>
      </form>}
  </>;
}

type Suggestion = Awaited<ReturnType<typeof suggestPeople>>[number];
const SUGGEST_DELAY = 150;
const fold = (text: string) => text.trim().replace(/^@/, '').toLowerCase();

/**
 * The "Message" box. As you type it lists matching members, people you have already messaged first, so a name you
 * have talked to opens that conversation rather than a new one. Arrow keys choose, Enter opens, Escape closes.
 */
function PersonSearch({ inbox, onOpen }: { inbox: Inbox | null, onOpen: (username: string) => void }) {
  const [name, setName] = useState('');
  const [found, setFound] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [note, setNote] = useState('');
  const text = fold(name);
  // Conversations already on screen match at once; the server's list replaces them when it answers.
  const known: Suggestion[] = (inbox?.conversations ?? [])
    .filter(c => c.with.username && (c.with.username.startsWith(text) || c.with.displayName.toLowerCase().split(/\s+/).some(w => w.startsWith(text))))
    .map(c => ({ ...c.with, username:c.with.username!, talked:true }));
  const options = text ? (found.length ? found : known).slice(0, 6) : [];

  useEffect(() => {
    setFound([]); setActive(-1);
    if (!text) return;
    const request = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/forum/messages/people?q=${encodeURIComponent(text)}`, { credentials:'include', signal:request.signal })
        .then(r => r.ok ? r.json() : { people:[] }).then(({ people }) => setFound(people)).catch(() => {});
    }, SUGGEST_DELAY);
    return () => { clearTimeout(timer); request.abort(); };
  }, [text]);

  const go = (username: string) => { onOpen(username); setName(''); setOpen(false); setNote(''); };
  // Enter with nothing chosen: a conversation I already have with that name or username, then an exact match, then
  // the only match, and only then the text as a username.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text) return;
    if (active >= 0 && options[active]) return go(options[active].username);
    const named = (p: { username: string | null, displayName: string }) => p.username === text || p.displayName.toLowerCase() === text;
    const existing = inbox?.conversations.find(c => c.with.username && named(c.with));
    if (existing) return go(existing.with.username!);
    const exact = options.find(named) ?? (options.length === 1 ? options[0] : undefined);
    if (exact) return go(exact.username);
    if (/^[a-z][a-z0-9_]{2,29}$/.test(text)) return go(text);
    setNote(options.length ? 'Choose a member from the list.' : 'No member matches that name.');
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && open && options.length) { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
    if (!options.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => (i + 1) % options.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setActive(i => i <= 0 ? options.length - 1 : i - 1); }
  };
  const showing = open && options.length > 0;
  return <form className="f-dm-start" onSubmit={submit}>
    <label className="sr-only" htmlFor="f-dm-to">Message a member by name or username</label>
    <input id="f-dm-to" value={name} placeholder="Message a member" autoComplete="off" spellCheck={false} maxLength={60}
      role="combobox" aria-autocomplete="list" aria-controls="f-dm-people" aria-expanded={showing}
      aria-activedescendant={showing && active >= 0 ? `f-dm-person-${active}` : undefined}
      onChange={e => { setName(e.target.value); setOpen(true); setNote(''); }} onKeyDown={keys}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} />
    <button className="account-button secondary" disabled={!text}>Go</button>
    {/* Pressing an option would blur the box and close the list first; keep focus so the click lands. */}
    <ul id="f-dm-people" className="f-dm-people" role="listbox" aria-label="Members" hidden={!showing} onMouseDown={e => e.preventDefault()}>
      {options.map((p, i) => <li key={p.username} id={`f-dm-person-${i}`} role="option" aria-selected={i === active} onClick={() => go(p.username)}>
        <Face person={p} />
        <span className="f-dm-who"><strong>{p.displayName}</strong><span className="forum-handle">@{p.username}</span></span>
        {p.talked && <span className="f-dm-time">Open chat</span>}
      </li>)}
    </ul>
    {note && <p className="f-dm-note" role="status">{note}</p>}
  </form>;
}

const preview = (last: Inbox['conversations'][number]['last']) => {
  if (last.deleted) return 'Message deleted';
  const what = last.body || (last.images > 1 ? `${last.images} images` : 'An image');
  return `${last.mine ? 'You: ' : ''}${what}`;
};

/**
 * The "⋯" menu on a conversation in the list: Block (or Unblock) and Delete. Arrow keys move between the items, Escape
 * or a click elsewhere closes it and gives focus back to its button. It opens upwards when there is no room below.
 */
function RowMenu({ name, blocked, busy, onPick }: { name: string, blocked: boolean, busy: boolean, onPick: (choice: 'block' | 'unblock' | 'delete') => void }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const toggle = () => {
    if (!open) {
      const scroller = button.current?.closest('.f-dm-scroll')?.getBoundingClientRect(), mine = button.current?.getBoundingClientRect();
      setUp(!!scroller && !!mine && scroller.bottom - mine.bottom < 100);
    }
    setOpen(now => !now);
  };
  const close = () => { setOpen(false); button.current?.focus(); };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  const pick = (choice: 'block' | 'unblock' | 'delete') => { setOpen(false); onPick(choice); };
  return <span className="f-dm-menu-wrap">
    <button ref={button} type="button" className="f-dm-icon f-dm-more" aria-label={`More for ${name}`} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={toggle}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
    </button>
    {open && <div ref={menu} className={`f-dm-menu${up ? ' up' : ''}`} role="menu" aria-label={`Conversation with ${name}`} onKeyDown={keys}>
      <button type="button" role="menuitem" onClick={() => pick(blocked ? 'unblock' : 'block')}>{blocked ? 'Unblock' : 'Block'}</button>
      <button type="button" role="menuitem" className="danger" onClick={() => pick('delete')}>Delete conversation</button>
    </div>}
  </span>;
}

function Conversations({ inbox, error, onOpen, onChange }: { inbox: Inbox | null, error: string, onOpen: (username: string) => void, onChange: () => Promise<unknown> }) {
  // Block and Delete ask first, in the row they are for; Unblock needs no asking. Deleting is for me only: the other
  // member keeps the conversation.
  const [asking, setAsking] = useState<{ username: string, what: 'block' | 'delete' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const run = async (request: () => Promise<unknown>) => {
    setBusy(true); setFailed('');
    try { await request(); await onChange(); setAsking(null); }
    catch (failure) { setFailed(handleAccountError(failure)); }
    finally { setBusy(false); }
  };
  const path = (username: string) => `/api/forum/messages/with/${username}`;
  const remove = (username: string) => run(() => api(path(username), { method:'DELETE', body:'{}' }));
  const block = (username: string, blocked: boolean) => run(() => api(`${path(username)}/block`, { method:'POST', body:JSON.stringify({ blocked }) }));
  const pick = (username: string) => (choice: 'block' | 'unblock' | 'delete') => {
    setFailed('');
    if (choice === 'unblock') { setAsking(null); block(username, false); }
    else setAsking({ username, what:choice });
  };
  return <>
    <PersonSearch inbox={inbox} onOpen={onOpen} />
    <div className="f-dm-scroll" aria-busy={!inbox}>
      {(failed || error) && <div className="account-error f-dm-error" role="alert">{failed || error}</div>}
      {!inbox && !error && <><span className="sr-only" role="status">Loading conversations</span><ListSkeleton /></>}
      {inbox && !inbox.conversations.length && <p className="f-dm-empty">No conversations yet. Choose <strong>Message</strong> beside a member's post, or search for them above.</p>}
      {inbox && inbox.conversations.length > 0 && <ul className="f-dm-list">{inbox.conversations.map(c => {
        const username = c.with.username;
        const name = username ? `@${username}` : c.with.displayName;
        return <li key={c.id}>
          <span className="f-dm-row">
            <button type="button" className={`f-dm-open${c.unread ? ' unread' : ''}`} disabled={!username} onClick={() => username && onOpen(username)}>
              <Face person={c.with} />
              <span className="f-dm-line">
                <span className="f-dm-line-top"><strong>{c.with.displayName}</strong><span className="f-dm-time">{time(c.last.createdAt)}</span></span>
                <span className="f-dm-preview">{c.blocked ? 'Blocked' : preview(c.last)}</span>
              </span>
              {c.unread && <span className="f-dm-dot"><span className="sr-only">Unread</span></span>}
            </button>
            {username && <RowMenu name={name} blocked={c.blocked} busy={busy} onPick={pick(username)} />}
          </span>
          {username && asking?.username === username && (asking.what === 'delete'
            ? <ConfirmBanner title={`Delete your conversation with ${name}?`}
                text="It is deleted for you only. They keep their copy and are not told. If either of you writes again, it comes back with only the new messages."
                action="Delete" doing="Deleting…" busy={busy} onConfirm={() => remove(username)} onCancel={() => setAsking(null)} />
            : <ConfirmBanner title={`Block ${name}?`}
                text="Neither of you will be able to send messages until you unblock them. They are not told, and what you have already said stays here."
                action="Block" doing="Blocking…" busy={busy} onConfirm={() => block(username, true)} onCancel={() => setAsking(null)} />)}
        </li>;
      })}</ul>}
    </div>
  </>;
}

const Glyph = () => <svg className="f-dm-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>;

// The chat dock: a bar in the bottom-right corner of every forum page that opens into a panel with the member's
// conversations. It shows only for members who can post (a verified, active account with a username); while that is
// being checked, a placeholder bar holds its place (and ForumLayout.astro draws the same one before this loads).
function Dock({ links }: { links: ForumLinks }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [ready, setReady] = useState<boolean | null>(null);
  const [place, setPlace] = useState(remembered);
  const [closing, setClosing] = useState(false);
  const [returning, setReturning] = useState(false);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [error, setError] = useState('');
  const bar = useRef<HTMLButtonElement>(null);

  const loadInbox = useCallback(() => api<Inbox>('/api/forum/messages').then(i => { setInbox(i); setError(''); }).catch(e => setError(handleAccountError(e))), []);
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { setReady(false); return; }
    api<{ account: Account }>('/api/account')
      .then(({ account }) => {
        const eligible = account.onboarded && account.emailVerified && account.status === 'active';
        setReady(eligible); setPlace(p => ({ ...p, eligible }));
        if (eligible) loadInbox();
      })
      .catch(() => setReady(false));
  }, [isLoaded, isSignedIn, loadInbox]);
  usePoll(ready ? loadInbox : null, place.open && !place.username ? LIST_POLL : INBOX_POLL);
  useEffect(() => { try { sessionStorage.setItem(REMEMBERED, JSON.stringify(place)); } catch {} }, [place]);
  useEffect(() => {
    const open = (e: Event) => {
      const username = (e as CustomEvent<{ username?: string }>).detail?.username;
      if (username) { setClosing(false); setPlace(p => ({ ...p, open:true, username })); }
    };
    window.addEventListener(OPEN_MESSAGES, open);
    return () => window.removeEventListener(OPEN_MESSAGES, open);
  }, []);
  // The panel folds away before the bar comes back.
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => {
      setClosing(false); setReturning(true);
      setPlace(p => ({ ...p, open:false }));
      requestAnimationFrame(() => bar.current?.focus());
    }, CLOSE_MS);
    return () => clearTimeout(timer);
  }, [closing]);

  const toggle = (open: boolean) => {
    if (open) { setReturning(false); setPlace(p => ({ ...p, open:true })); loadInbox(); return; }
    if (reducedMotion()) { setPlace(p => ({ ...p, open:false })); requestAnimationFrame(() => bar.current?.focus()); }
    else setClosing(true);
  };

  if (ready === false) return null;
  if (ready === null) {
    if (place.eligible === false) return null;
    return place.open
      ? <section className="f-dm-panel" aria-label="Messages" aria-busy="true">
          <div className="f-dm-head" aria-hidden="true"><Glyph /><span className="f-dm-title">Messages</span></div>
          <div className="f-dm-scroll">{place.username ? <ChatSkeleton /> : <ListSkeleton />}</div>
        </section>
      : <BarSkeleton />;
  }
  const unread = inbox?.unread ?? 0;
  const title = <>Messages{unread > 0 && <span className="f-dm-count">{unread}<span className="sr-only"> unread</span></span>}</>;

  if (!place.open) return <button ref={bar} className={`f-dm-bar${returning ? ' returning' : ''}`} type="button" aria-expanded="false" aria-controls="f-dm-panel" onClick={() => toggle(true)}>
    <Glyph />
    <span className="f-dm-title">{title}</span>
    <svg className="f-dm-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
  </button>;

  return <section id="f-dm-panel" className={`f-dm-panel${closing ? ' closing' : ''}`} aria-label="Messages" onKeyDown={e => { if (e.key === 'Escape') toggle(false); }}>
    <button className="f-dm-head" type="button" aria-expanded="true" aria-controls="f-dm-panel" onClick={() => toggle(false)}>
      <Glyph />
      <span className="f-dm-title">{title}</span>
      <span className="sr-only">Minimise</span>
      <svg className="f-dm-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    {place.username
      ? <Chat key={place.username} username={place.username} links={links} onRead={loadInbox} onBack={() => { setPlace(p => ({ ...p, username:null })); loadInbox(); }} />
      : <Conversations inbox={inbox} error={error} onChange={loadInbox} onOpen={username => setPlace(p => ({ ...p, username }))} />}
  </section>;
}

export default function MessagesDock(props: { links: ForumLinks }) {
  return <AuthProvider><Dock {...props} /></AuthProvider>;
}
