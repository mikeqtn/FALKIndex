import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useClerk } from '@clerk/react';
import { profileInput, qualificationOptions, type Account, type ProfileInput } from '../../accounts/contracts';
import { api, dateLabel, handleAccountError } from './api';
import { AuthProvider } from './AuthProvider';

type Meta = { qualificationOptions: { value: string; label: string }[]; organizations: { id: string; name: string }[] };
const blank: ProfileInput = {
  username: '', displayName: '', realName: '', showRealName: false, bio: '',
  qualifications: [], qualificationDetails: '', professionalAffiliations: '',
  website: '', brandTies: [],
};
// Text fields that validation can flag, by their input id and visible label.
const fieldIds: Partial<Record<keyof ProfileInput, string>> = {
  username: 'username', displayName: 'displayName', realName: 'realName', bio: 'bio', website: 'website',
  qualificationDetails: 'qualificationDetails', professionalAffiliations: 'affiliations',
};
const fieldLabels: Partial<Record<keyof ProfileInput, string>> = {
  username: 'Username', displayName: 'Display name', realName: 'Real name', bio: 'Biography', website: 'Website',
  qualificationDetails: 'Qualification context', professionalAffiliations: 'Professional affiliations',
};

// Deleting erases the member's personal details and closes their sign-in; their contributions stay,
// credited to a deleted member (see deleteAccount in server/accounts.ts).
function DeleteAccount() {
  const clerk = useClerk();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/api/account', { method: 'DELETE', body: JSON.stringify({ confirm }) });
      await clerk.signOut().catch(() => {});
      window.location.assign('/');
    } catch (e) { setError(handleAccountError(e)); setBusy(false); }
  }
  // Closed until asked for, so the page does not open on a destructive form.
  return (
    <Section id="delete-heading" title="Delete account"
      help="Erases your personal details, profile and verifications, and closes your sign-in. Contributions stay, credited to a deleted member. This can't be undone.">
      <details className="acct-delete">
        <summary className="account-button danger">Delete account…</summary>
        <form className="acct-delete-form" aria-labelledby="delete-heading" onSubmit={remove}>
          {error && <div className="account-error" role="alert">{error}</div>}
          <div className="account-field"><label htmlFor="delete-confirm">Type DELETE to confirm</label>
            <input id="delete-confirm" autoComplete="off" value={confirm} onChange={e => setConfirm(e.target.value)} /></div>
          <div><button className="account-button danger" type="submit" disabled={busy || confirm.trim().toLowerCase() !== 'delete'}>{busy ? 'Deleting…' : 'Delete my account'}</button></div>
        </form>
      </details>
    </Section>
  );
}

// One settings row: what the section is, beside its fields.
function Section({ id, title, help, children }: { id: string; title: string; help?: string; children: ReactNode }) {
  return (
    <section className="acct-row" aria-labelledby={id}>
      <div className="acct-row-label"><h2 id={id}>{title}</h2>{help && <p>{help}</p>}</div>
      <div className="acct-row-body">{children}</div>
    </section>
  );
}
const ROLE_NAMES: Record<string, string> = { contributor: 'Contributor', editor: 'Editor', admin: 'Administrator' };

function AccountEditor() {
  const clerk = useClerk();
  const [account, setAccount] = useState<Account | null>(null);
  const [email, setEmail] = useState('');
  const [form, setForm] = useState<ProfileInput>(blank);
  const [meta, setMeta] = useState<Meta>({ qualificationOptions, organizations: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<keyof ProfileInput | ''>('');
  const [metaWarning, setMetaWarning] = useState('');
  const [notice, setNotice] = useState('');
  const [orgQuery, setOrgQuery] = useState('');
  // The form as last loaded or saved, to tell whether anything is waiting to be saved.
  const [savedForm, setSavedForm] = useState('');
  const isSetup = !account?.username;
  const dirty = !loading && JSON.stringify(form) !== savedForm;
  // Leaving with unsaved edits asks first, as the browser allows.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ account: Account; email: string }>('/api/account?fresh=1'),
      api<Meta>('/api/accounts/meta').catch(reason => {
        if (alive) setMetaWarning(handleAccountError(reason));
        return { qualificationOptions, organizations: [] };
      }),
    ]).then(([result, metadata]) => {
      if (!alive) return;
      setAccount(result.account);
      setEmail(result.email);
      const profile = result.account.profile;
      const loaded: ProfileInput = {
        username: result.account.username ?? '',
        displayName: profile.displayName ?? '',
        realName: profile.realName ?? '',
        showRealName: profile.showRealName ?? false,
        bio: profile.bio ?? '',
        qualifications: profile.qualifications ?? [],
        qualificationDetails: profile.qualificationDetails ?? '',
        professionalAffiliations: profile.professionalAffiliations ?? '',
        website: profile.website ?? '',
        brandTies: profile.brandTies ?? [],
      };
      setForm(loaded);
      setSavedForm(JSON.stringify(loaded));
      setMeta(metadata);
    }).catch((reason: unknown) => setError(handleAccountError(reason)))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  function update<K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) {
    setForm(current => ({ ...current, [key]: value }));
    setNotice('');
    if (key === errorField) setErrorField('');
  }
  /** Marks the field that failed validation and points it at the error message. */
  const invalid = (key: keyof ProfileInput, help?: string) => {
    const describedBy = [help, errorField === key ? 'profile-error' : ''].filter(Boolean).join(' ');
    return { 'aria-invalid': errorField === key || undefined, 'aria-describedby': describedBy || undefined };
  };
  function toggleQualification(value: string) {
    const selected = value as ProfileInput['qualifications'][number];
    const next = form.qualifications.includes(selected)
      ? form.qualifications.filter(item => item !== selected)
      : [...form.qualifications, selected];
    update('qualifications', next as ProfileInput['qualifications']);
  }
  // Disclosures: chosen ties show as chips; the rest are found by name rather than listed all at once.
  const orgName = (id: string) => meta.organizations.find(org => org.id === id)?.name ?? id;
  const orgSearch = orgQuery.trim().toLowerCase();
  const orgMatches = orgSearch
    ? meta.organizations.filter(org => !form.brandTies.includes(org.id) && org.name.toLowerCase().includes(orgSearch)).slice(0, 8)
    : [];
  function addBrand(id: string) {
    toggleBrand(id);
    document.getElementById('org-search')?.focus();
  }
  function toggleBrand(id: string) {
    const next = form.brandTies.includes(id) ? form.brandTies.filter(item => item !== id) : [...form.brandTies, id];
    update('brandTies', next);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(''); setErrorField(''); setNotice('');
    const parsed = profileInput.safeParse(form);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const key = issue?.path[0] as keyof ProfileInput | undefined;
      const input = key && document.getElementById(fieldIds[key] ?? '');
      setError(key && fieldLabels[key] ? `${fieldLabels[key]}: ${issue.message}` : issue?.message ?? 'Check the profile fields.');
      setErrorField(key ?? '');
      (input || document.getElementById('profile-error'))?.focus();
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ account: Account }>('/api/account', { method: 'PATCH', body: JSON.stringify(parsed.data) });
      setAccount(result.account);
      setSavedForm(JSON.stringify(form));
      setNotice('Saved.');
    } catch (reason) {
      setError(handleAccountError(reason));
      document.getElementById('profile-error')?.focus();
    } finally { setBusy(false); }
  }
  // Loading keeps the final layout: the header, then flat bars where the rows will be (no shimmer).
  if (loading) return (
    <div className="acct" role="status"><span className="sr-only">Loading account</span>
      <div className="acct-head" aria-hidden="true"><div className="account-avatar acct-avatar" /><div className="acct-head-text"><div className="account-skeleton" /><div className="account-skeleton" /></div></div>
      <div className="acct-row" aria-hidden="true"><div className="account-skeleton" /><div className="account-skeleton" /></div>
    </div>
  );
  // Suspended and unverified members cannot load their account, but may still delete it.
  if (error && !account) return (
    <div className="acct">
      <div className="account-error acct-alert" role="alert">{error} <button className="account-button secondary" type="button" onClick={() => window.location.reload()}>Try again</button></div>
      <DeleteAccount />
    </div>
  );

  const verified = account?.status !== 'suspended' && account?.emailVerified;
  const statusText = account?.status === 'suspended' ? 'Suspended' : verified ? 'Verified' : 'Email not verified';
  const initial = (form.displayName || form.username || '?').slice(0, 1).toUpperCase();
  return (
    <div className="acct">
      <header className="acct-head">
        <div className="account-avatar acct-avatar">{account?.profile.imageUrl ? <img src={account.profile.imageUrl} alt="" /> : initial}</div>
        <div className="acct-head-text">
          <h1>{isSetup ? 'Set up your profile' : 'Your account'}</h1>
          <p className="acct-facts">
            <span>{email}</span>
            <span className={verified ? 'acct-ok' : 'acct-warn'}>{statusText}</span>
            {account && <span>{ROLE_NAMES[account.role] ?? account.role}</span>}
            {account?.createdAt && <span>Joined {dateLabel(account.createdAt)}</span>}
          </p>
        </div>
        {account?.username && <nav className="acct-links" aria-label="Your pages">
          <a href={`/people/${encodeURIComponent(account.username)}`}>Public profile</a>
          <a href="/account/contributions/">Contributions</a>
        </nav>}
      </header>

      {error && <div id="profile-error" className="account-error acct-alert" role="alert" tabIndex={-1}>{error}</div>}
      {metaWarning && <div className="account-error acct-alert" role="alert">Profile options unavailable: {metaWarning} <button className="account-button secondary" type="button" onClick={() => window.location.reload()}>Retry</button></div>}
      {account?.status === 'suspended' && <div className="account-error acct-alert" role="alert">This account is suspended. Catalogue records stay available without signing in.</div>}

      <form onSubmit={save} noValidate>
        <Section id="profile-heading" title="Profile" help="Shown on your public profile. Leave a field blank to keep it private.">
          <div className="acct-grid">
            {isSetup
              ? <div className="account-field"><label htmlFor="username">Username</label><input id="username" autoComplete="username" required minLength={3} maxLength={30} pattern="[a-z][a-z0-9_]{2,29}" value={form.username} onChange={e => update('username', e.target.value.toLowerCase())} {...invalid('username', 'username-help')} /><small id="username-help">3–30 lowercase letters, numbers or underscores; start with a letter. It can't be changed later.</small></div>
              : <div className="account-field"><span className="account-label">Username</span><p className="acct-static">@{form.username}</p><small>Usernames can't be changed.</small></div>}
            <div className="account-field"><label htmlFor="displayName">Display name</label><input id="displayName" {...invalid('displayName')} maxLength={100} value={form.displayName} onChange={e => update('displayName', e.target.value)} /></div>
            <div className="account-field"><label htmlFor="realName">Real name</label><input id="realName" {...invalid('realName')} maxLength={150} autoComplete="name" value={form.realName} onChange={e => update('realName', e.target.value)} /><label className="acct-check"><input type="checkbox" checked={form.showRealName} onChange={e => update('showRealName', e.target.checked)} /><span>Show it on my public profile</span></label></div>
            <div className="account-field"><label htmlFor="website">Website</label><input id="website" {...invalid('website')} type="url" placeholder="https://" value={form.website} onChange={e => update('website', e.target.value)} /></div>
            <div className="account-field acct-wide"><label htmlFor="bio">Biography</label><textarea id="bio" {...invalid('bio')} maxLength={2000} value={form.bio} onChange={e => update('bio', e.target.value)} /></div>
            <div className="account-field acct-wide"><span className="account-label">Photo</span><div className="acct-inline"><span className="account-avatar acct-photo" aria-hidden="true">{account?.profile.imageUrl ? <img src={account.profile.imageUrl} alt="" /> : initial}</span><button className="account-button secondary" type="button" onClick={() => clerk.openUserProfile()}>Change photo</button><small>It comes from your sign-in account. Reload this page after changing it.</small></div></div>
          </div>
        </Section>

        <Section id="qualifications-heading" title="Qualifications" help="Self-reported. They aren't verified and don't change your role.">
          <div className="account-toggles" role="group" aria-labelledby="qualifications-heading">{meta.qualificationOptions.map(option => <label className="account-toggle" key={option.value}><input type="checkbox" checked={form.qualifications.includes(option.value)} onChange={() => toggleQualification(option.value)} />{option.label}</label>)}</div>
          <div className="acct-grid">
            <div className="account-field"><label htmlFor="qualificationDetails">Context</label><textarea id="qualificationDetails" {...invalid('qualificationDetails')} maxLength={1500} value={form.qualificationDetails} onChange={e => update('qualificationDetails', e.target.value)} /></div>
            <div className="account-field"><label htmlFor="affiliations">Professional affiliations</label><textarea id="affiliations" {...invalid('professionalAffiliations')} maxLength={1500} value={form.professionalAffiliations} onChange={e => update('professionalAffiliations', e.target.value)} /></div>
          </div>
        </Section>

        <Section id="disclosures-heading" title="Disclosures" help="Organizations you're tied to, shown to readers. Verified affiliations are listed separately.">
          {form.brandTies.length
            ? <ul className="account-toggles" aria-label="Disclosed organizations">{form.brandTies.map(id => <li key={id}><button type="button" className="account-toggle is-on" aria-label={`Remove ${orgName(id)}`} onClick={() => toggleBrand(id)}>{orgName(id)}<span className="account-toggle-x" aria-hidden="true">×</span></button></li>)}</ul>
            : <p className="account-help">None disclosed.</p>}
          {meta.organizations.length ? <div className="account-field">
            <label htmlFor="org-search">Add an organization</label>
            <input id="org-search" type="search" autoComplete="off" placeholder="Brand, supplier or group" value={orgQuery} onChange={e => setOrgQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (orgMatches[0]) addBrand(orgMatches[0].id); } }} />
            {orgSearch && (orgMatches.length
              ? <ul className="account-toggles" aria-label="Matching organizations">{orgMatches.map(org => <li key={org.id}><button type="button" className="account-toggle" aria-label={`Add ${org.name}`} onClick={() => addBrand(org.id)}>{org.name}</button></li>)}</ul>
              : <p className="account-help">No organization matches “{orgQuery.trim()}”.</p>)}
            <p className="sr-only" role="status">{orgSearch ? `${orgMatches.length} matching organizations` : ''}</p>
          </div> : <p className="account-help">No organizations are available to disclose yet.</p>}
        </Section>

        {/* Waits at the foot of the form, and follows the reader up the page once something has changed. */}
        <div className={`acct-save${dirty ? ' is-dirty' : ''}`}>
          <span className="acct-saved" role="status">{dirty ? 'Unsaved changes' : notice}</span>
          <button className="account-button" type="submit" disabled={busy || (!dirty && !isSetup)}>{busy ? 'Saving…' : isSetup ? 'Create profile' : 'Save changes'}</button>
        </div>
      </form>

      {!isSetup && <DeleteAccount />}
    </div>
  );
}

export default function AccountApp() {
  return <AuthProvider><AccountEditor /></AuthProvider>;
}
