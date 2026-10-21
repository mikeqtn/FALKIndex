import { useEffect, useState, type FormEvent } from 'react';
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
  const isSetup = !account?.username;

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ account: Account; email: string }>('/api/account'),
      api<Meta>('/api/accounts/meta').catch(reason => {
        if (alive) setMetaWarning(handleAccountError(reason));
        return { qualificationOptions, organizations: [] };
      }),
    ]).then(([result, metadata]) => {
      if (!alive) return;
      setAccount(result.account);
      setEmail(result.email);
      const profile = result.account.profile;
      setForm({
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
      });
      setMeta(metadata);
    }).catch((reason: unknown) => setError(handleAccountError(reason)))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  function update<K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) {
    setForm(current => ({ ...current, [key]: value }));
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
      setNotice('Your account profile has been saved.');
    } catch (reason) {
      setError(handleAccountError(reason));
      document.getElementById('profile-error')?.focus();
    } finally { setBusy(false); }
  }
  if (loading) return <div className="account-panel account-loading" role="status"><span className="sr-only">Loading account</span><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /></div>;
  if (error && !account) return <div className="account-panel account-stack"><div className="account-error" role="alert">{error}</div><button className="account-button secondary" type="button" onClick={() => window.location.reload()}>Try again</button></div>;

  const statusText = account?.status === 'suspended' ? 'Account suspended' : account?.emailVerified ? 'Email verified' : 'Email not verified';
  return (
    <div className="account-shell">
      <header className="account-heading">
        <div><p className="account-kicker">FALK Index / Reader account</p><h1 className="account-title">{isSetup ? 'Set up your profile' : 'Your account'}</h1><p className="account-intro">Keep authorship and professional context transparent. Your profile is separate from your private account details.</p></div>
      </header>
      <div className="account-stack" style={{ marginTop: 22 }}>
        {error && <div id="profile-error" className="account-error" role="alert" tabIndex={-1}>{error}</div>}
        {metaWarning && <div className="account-error" role="alert">Profile option list unavailable: {metaWarning} <button className="account-button secondary" type="button" onClick={() => window.location.reload()}>Retry options</button></div>}
        {notice && <div className="account-notice" role="status">{notice}</div>}
        {account?.status === 'suspended' && <div className="account-error" role="alert">This account is suspended. Public catalogue records remain available without signing in.</div>}
        <section className="account-panel account-stack" aria-labelledby="private-heading">
          <div className="account-heading"><div><h2 id="private-heading">Account status</h2><p>{email}</p></div><span className={`account-chip ${account?.emailVerified ? 'verified' : ''}`}>{statusText}</span></div>
          <div className="account-meta"><span>Role: {account?.role}</span><span>Joined {account?.createdAt ? dateLabel(account.createdAt) : '—'}</span></div>
          {account?.username && <p><a href={`/people/${encodeURIComponent(account.username)}`}>View your public profile</a></p>}
          <p className="account-help">Role and email verification are managed separately from qualifications. Self-reported qualifications never grant contributor, editor or administrator access.</p>
        </section>
        <form className="account-panel account-stack" onSubmit={save} noValidate>
          <div><p className="account-kicker">Public profile</p><h2>{isSetup ? 'Choose a public username' : 'Profile details'}</h2><p className="account-help">Only the fields described here are shown on your public profile. Leave a field blank to keep it undisclosed.</p></div>
          <div className="account-form-grid">
            <div className="account-field"><label htmlFor="username">Username</label><input id="username" autoComplete="username" required minLength={3} maxLength={30} pattern="[a-z][a-z0-9_]{2,29}" value={form.username} disabled={!isSetup} onChange={e => update('username', e.target.value.toLowerCase())} {...invalid('username', 'username-help')} /><small id="username-help">{isSetup ? '3–30 lowercase letters, numbers or underscores; start with a letter.' : 'Usernames cannot be changed after profile setup.'}</small></div>
            <div className="account-field"><label htmlFor="displayName">Display name</label><input id="displayName" {...invalid('displayName')} maxLength={100} value={form.displayName} onChange={e => update('displayName', e.target.value)} /></div>
            <div className="account-field"><label htmlFor="realName">Real name <span className="muted">(private by default)</span></label><input id="realName" {...invalid('realName')} maxLength={150} autoComplete="name" value={form.realName} onChange={e => update('realName', e.target.value)} /><label className="account-check"><input type="checkbox" checked={form.showRealName} onChange={e => update('showRealName', e.target.checked)} /><span>Show my real name on my public profile</span></label></div>
            <div className="account-field"><label htmlFor="bio">Biography</label><textarea id="bio" {...invalid('bio')} maxLength={2000} value={form.bio} onChange={e => update('bio', e.target.value)} /></div>
            <div className="account-field"><label htmlFor="website">Website</label><input id="website" {...invalid('website')} type="url" placeholder="https://" value={form.website} onChange={e => update('website', e.target.value)} /></div>
            <div className="account-field"><span className="account-label">Profile photo</span><div className="account-profile-head"><div className="account-avatar">{account?.profile.imageUrl ? <img src={account.profile.imageUrl} alt="" /> : (form.displayName || form.username || '?').slice(0, 1).toUpperCase()}</div><button className="account-button secondary" type="button" onClick={() => clerk.openUserProfile()}>Change photo</button></div><small>Your photo comes from your sign-in account. Reload this page after changing it.</small></div>
          </div>
          <hr className="account-divider" />
          <fieldset className="account-stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="account-label">Self-reported qualifications</legend>
            <p className="account-help">These describe your experience; they are not independent verification and do not grant roles.</p>
            <div className="account-toggles">{meta.qualificationOptions.map(option => <label className="account-toggle" key={option.value}><input type="checkbox" checked={form.qualifications.includes(option.value)} onChange={() => toggleQualification(option.value)} />{option.label}</label>)}</div>
            <div className="account-form-grid">
              <div className="account-field"><label htmlFor="qualificationDetails">Qualification context</label><textarea id="qualificationDetails" {...invalid('qualificationDetails')} maxLength={1500} value={form.qualificationDetails} onChange={e => update('qualificationDetails', e.target.value)} /></div>
              <div className="account-field"><label htmlFor="affiliations">Professional affiliations</label><textarea id="affiliations" {...invalid('professionalAffiliations')} maxLength={1500} value={form.professionalAffiliations} onChange={e => update('professionalAffiliations', e.target.value)} /></div>
            </div>
          </fieldset>
          <fieldset className="account-stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="account-label">Organization disclosures</legend>
            <p className="account-help">Declare ties you want readers to see. Independently verified affiliations appear in a separate section on your profile.</p>
            {form.brandTies.length
              ? <ul className="account-toggles" aria-label="Disclosed organizations">{form.brandTies.map(id => <li key={id}><button type="button" className="account-toggle is-on" aria-label={`Remove ${orgName(id)}`} onClick={() => toggleBrand(id)}>{orgName(id)}<span className="account-toggle-x" aria-hidden="true">×</span></button></li>)}</ul>
              : <p className="account-help">No ties disclosed.</p>}
            {meta.organizations.length ? <div className="account-field">
              <label htmlFor="org-search">Add an organization</label>
              <input id="org-search" type="search" autoComplete="off" placeholder="Brand, supplier or group" value={orgQuery} onChange={e => setOrgQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (orgMatches[0]) addBrand(orgMatches[0].id); } }} />
              {orgSearch && (orgMatches.length
                ? <ul className="account-toggles" aria-label="Matching organizations">{orgMatches.map(org => <li key={org.id}><button type="button" className="account-toggle" aria-label={`Add ${org.name}`} onClick={() => addBrand(org.id)}>{org.name}</button></li>)}</ul>
                : <p className="account-help">No organization matches “{orgQuery.trim()}”.</p>)}
              <p className="sr-only" role="status">{orgSearch ? `${orgMatches.length} matching organizations` : ''}</p>
            </div> : <p className="account-empty">No organizations are available to disclose at present.</p>}
          </fieldset>
          <div className="account-actions"><button className="account-button" type="submit" disabled={busy}>{busy ? 'Saving profile…' : 'Save profile'}</button><a className="account-button secondary" href="/records/">Return to catalogue</a></div>
        </form>
      </div>
    </div>
  );
}

export default function AccountApp() {
  return <AuthProvider><AccountEditor /></AuthProvider>;
}
