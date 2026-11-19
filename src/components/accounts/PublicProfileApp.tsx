import { useEffect, useState } from 'react';
import type { PublicProfile } from '../../accounts/contracts';
import { qualificationOptions } from '../../accounts/contracts';
import { api, ApiError, dateLabel, handleAccountError } from './api';
import '../../styles/accounts.css';

export default function PublicProfileApp({ username }: { username: string }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const load = () => {
    setLoading(true); setError(''); setNotFound(false);
    api<{ profile: PublicProfile }>(`/api/profiles/${encodeURIComponent(username)}`)
      .then(result => setProfile(result.profile))
      .catch(reason => { setNotFound(reason instanceof ApiError && reason.status === 404); setError(handleAccountError(reason)); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [username]);

  if (loading) return <div className="account-shell account-panel account-loading" role="status"><span className="sr-only">Loading public profile</span><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /></div>;
  if (error || !profile) return (
    <section className="account-shell account-panel account-stack">
      <h1 className="account-title">{notFound ? 'Profile not found' : 'Profile unavailable'}</h1>
      {notFound
        ? <p className="account-help">No member is called @{username}.</p>
        : error && <p className="account-error" role="alert">{error}</p>}
      {/* Retrying cannot find a member who does not exist, so only a failed load offers it. */}
      <div className="account-actions">{!notFound && <button className="account-button secondary" type="button" onClick={load}>Try again</button>}<a href="/records/">Browse records</a></div>
    </section>
  );
  const display = profile.displayName || profile.realName || profile.username;
  return (
    <article className="account-shell">
      <header className="account-panel account-stack">
        <div className="account-profile-head">
          <div className="account-avatar">{profile.imageUrl ? <img src={profile.imageUrl} alt="" /> : display.slice(0, 1).toUpperCase()}</div>
          <div><h1 className="account-title">{display}</h1><p className="account-help">@{profile.username}</p><div className="account-meta"><span className="account-chip">{profile.role}</span><span className="account-chip">Member since {dateLabel(profile.createdAt)}</span></div></div>
        </div>
        {profile.status === 'suspended' && <p className="account-notice">This account is suspended. Previously published contributions remain attributed.</p>}
        {profile.bio && <p className="account-intro">{profile.bio}</p>}
        <div className="account-actions">
          {profile.website && <a className="account-button secondary" href={profile.website} target="_blank" rel="nofollow ugc noreferrer">Website</a>}
        </div>
      </header>
      <section className="account-panel account-stack">
        <h2>Qualifications</h2>
        {profile.realName && <p><strong>Name:</strong> {profile.realName}</p>}
        {profile.qualifications.length ? <div className="account-chips">{profile.qualifications.map(value => <span className="account-chip" key={value}>{qualificationOptions.find(option => option.value === value)?.label ?? value}</span>)}</div> : <p className="account-help">No qualifications have been self-reported.</p>}
        {profile.qualificationDetails && <p>{profile.qualificationDetails}</p>}
        {profile.professionalAffiliations && <p><strong>Affiliations:</strong> {profile.professionalAffiliations}</p>}
        <aside className="account-notice">Qualifications are self-reported. They do not confer an account role or constitute independent verification.</aside>
      </section>
      {/* On its own, so a reader checking for conflicts of interest finds it at once. */}
      <section className="account-panel account-stack">
        <h2>Disclosures</h2>
        <p className="account-help">Organizations this member declares ties to. Self-reported, not independently verified.</p>
        {profile.brandTies.length
          ? <div className="account-chips">{profile.brandTies.map(org => <span className="account-chip" key={org.id}>{org.name}</span>)}</div>
          : <p className="account-empty">No organization ties declared.</p>}
      </section>
      <section className="account-panel account-stack">
        <h2>Professional verifications</h2>
        {profile.verifications.length ? <ul className="account-list">{profile.verifications.map(item => <li key={item.id}><div className="account-record"><div><strong>{item.label}</strong>{item.organizationName && <p className="account-help">{item.organizationName}</p>}</div><span className="account-verified"><span className="account-chip verified">Verified {dateLabel(item.verifiedAt)}</span><a href={item.evidenceUrl} target="_blank" rel="noreferrer">Evidence</a></span></div></li>)}</ul> : <p className="account-empty">No independent professional verifications are listed.</p>}
      </section>
      <section className="account-panel account-stack">
        <h2>Contributions</h2>
        <dl className="account-counts">
          <div><dt>Published</dt><dd>{profile.acceptedCount}</dd></div>
          <div><dt>Pending</dt><dd>{profile.pendingCount}</dd></div>
          <div><dt>Not accepted</dt><dd>{profile.rejectedCount}</dd></div>
        </dl>
        {profile.acceptedCount === 0 && profile.contributions.length === 0 ? <p className="account-empty">No published contributions yet. Counts reflect the catalogue database, not estimated activity.</p> : (
          profile.contributions.length ? <ul className="account-list">{profile.contributions.map(item => <li key={item.id}><div className="account-record"><a href={item.url}>{item.title}</a><span className="account-help">{dateLabel(item.createdAt)}</span></div></li>)}</ul> : <p className="account-help">Contribution details are not publicly listed.</p>
        )}
      </section>
      {profile.editorialActions.length > 0 && <section className="account-panel account-stack"><h2>Editorial actions</h2><ul className="account-list">{profile.editorialActions.map(item => <li key={item.id}><strong>{item.action}</strong>{item.target && <span> · {item.target}</span>}<p className="account-help">{dateLabel(item.createdAt)}</p></li>)}</ul></section>}
    </article>
  );
}
