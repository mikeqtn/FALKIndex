import { useEffect, useState } from 'react';
import type { PublicProfile } from '../../accounts/contracts';
import { qualificationOptions } from '../../accounts/contracts';
import { api, ApiError, dateLabel, handleAccountError } from './api';
import { Section, roleName } from './AccountRow';
import '../../styles/accounts.css';

// A member's public page, in the account page's layout: who they are at the top, then one row per kind of record.
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

  if (loading) return (
    <div className="acct" role="status">
      <span className="sr-only">Loading profile</span>
      <div className="acct-head" aria-hidden="true"><div className="account-avatar acct-avatar" /><div className="acct-head-text"><div className="account-skeleton" /><div className="account-skeleton" /></div></div>
    </div>
  );
  if (error || !profile) return (
    <section className="acct acct-missing">
      <h1>{notFound ? 'Profile not found' : 'Profile unavailable'}</h1>
      <p className="account-help">{notFound ? `No member is called @${username}.` : error}</p>
      <div className="acct-inline">
        {!notFound && <button className="account-button secondary" type="button" onClick={load}>Try again</button>}
        <a href="/records/">Browse records</a>
      </div>
    </section>
  );

  const display = profile.displayName || profile.realName || profile.username;
  const qualification = (value: string) => qualificationOptions.find(option => option.value === value)?.label ?? value;
  return (
    <article className="acct">
      <header className="acct-head">
        <div className="account-avatar acct-avatar">{profile.imageUrl ? <img src={profile.imageUrl} alt="" /> : display.slice(0, 1).toUpperCase()}</div>
        <div className="acct-head-text">
          <h1>{display}</h1>
          <p className="acct-facts">
            <span>@{profile.username}</span>
            <span>{roleName(profile.role)}</span>
            <span>Member since {dateLabel(profile.createdAt)}</span>
          </p>
        </div>
        {profile.website && <nav className="acct-links" aria-label="Elsewhere"><a href={profile.website} target="_blank" rel="nofollow ugc noreferrer">Website</a></nav>}
      </header>

      {profile.status === 'suspended' && <p className="account-notice acct-alert">This account is suspended. Previously published contributions remain attributed.</p>}
      {profile.bio && <p className="acct-bio">{profile.bio}</p>}

      <Section id="qualifications-heading" title="Qualifications" help="Self-reported. They are not verified and don’t confer an account role.">
        {profile.realName && <p><span className="account-label">Name</span> {profile.realName}</p>}
        {profile.qualifications.length
          ? <ul className="account-chips" aria-label="Qualifications">{profile.qualifications.map(value => <li className="account-chip" key={value}>{qualification(value)}</li>)}</ul>
          : <p className="account-help">No qualifications have been self-reported.</p>}
        {profile.qualificationDetails && <p className="acct-prose">{profile.qualificationDetails}</p>}
        {profile.professionalAffiliations && <p className="acct-prose"><span className="account-label">Affiliations</span> {profile.professionalAffiliations}</p>}
      </Section>

      <Section id="disclosures-heading" title="Disclosures" help="Organizations this member says they are tied to. Self-reported, not independently checked.">
        {profile.brandTies.length
          ? <ul className="account-chips" aria-label="Disclosed organizations">{profile.brandTies.map(org => <li className="account-chip" key={org.id}>{org.name}</li>)}</ul>
          : <p className="account-help">None disclosed.</p>}
      </Section>

      <Section id="verifications-heading" title="Verifications" help="Professional roles checked independently, with the evidence linked.">
        {profile.verifications.length
          ? <ul className="account-list">{profile.verifications.map(item => (
            <li key={item.id} className="account-record">
              <div><strong>{item.label}</strong>{item.organizationName && <p className="account-help">{item.organizationName}</p>}</div>
              <div className="acct-inline"><span className="account-chip verified">Verified {dateLabel(item.verifiedAt)}</span><a href={item.evidenceUrl} target="_blank" rel="noreferrer">Evidence</a></div>
            </li>))}</ul>
          : <p className="account-help">No independent professional verifications are listed.</p>}
      </Section>

      <Section id="contributions-heading" title="Contributions" help="Counted from the catalogue database, not estimated.">
        <dl className="acct-counts">
          <div><dt>Published</dt><dd>{profile.acceptedCount}</dd></div>
          <div><dt>Pending</dt><dd>{profile.pendingCount}</dd></div>
          <div><dt>Not accepted</dt><dd>{profile.rejectedCount}</dd></div>
        </dl>
        {profile.contributions.length
          ? <ul className="account-list">{profile.contributions.map(item => <li key={item.id} className="account-record"><a href={item.url}>{item.title}</a><span className="account-help">{dateLabel(item.createdAt)}</span></li>)}</ul>
          : <p className="account-help">{profile.acceptedCount === 0 ? 'No published contributions yet.' : 'Contribution details are not publicly listed.'}</p>}
      </Section>

      {profile.editorialActions.length > 0 && (
        <Section id="editorial-heading" title="Editorial actions">
          <ul className="account-list">{profile.editorialActions.map(item => <li key={item.id} className="account-record"><span><strong>{item.action}</strong>{item.target && <> on {item.target}</>}</span><span className="account-help">{dateLabel(item.createdAt)}</span></li>)}</ul>
        </Section>
      )}
    </article>
  );
}
