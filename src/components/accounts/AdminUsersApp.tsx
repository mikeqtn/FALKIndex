import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@clerk/react';
import type { AdminMember, Role, Verification } from '../../accounts/contracts';
import { ROLES } from '../../accounts/contracts';
import { api, dateLabel, handleAccountError } from './api';
import { AuthProvider } from './AuthProvider';

type MemberPage = { accounts: AdminMember[]; page: number; total: number };
type Detail = { account: AdminMember; verifications: Verification[]; audit: { id: string; action: string; createdAt: string; reason: string }[] };
type Meta = { organizations: { id: string; name: string }[] };

function AdminConsole() {
  const [result, setResult] = useState<MemberPage | null>(null);
  const [meta, setMeta] = useState<Meta>({ organizations: [] });
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  // Access changes apply only from the explicit button, never while arrowing through a select.
  const [pendingRole, setPendingRole] = useState<Role>('contributor');
  const [pendingStatus, setPendingStatus] = useState<'active' | 'suspended'>('active');
  const [reason, setReason] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('contributor');
  const [inviteReason, setInviteReason] = useState('');
  const [verifyLabel, setVerifyLabel] = useState('');
  const [verifyOrg, setVerifyOrg] = useState('');
  const [verifyUrl, setVerifyUrl] = useState('');
  const [verifyReason, setVerifyReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [metaError, setMetaError] = useState('');
  const [notice, setNotice] = useState('');

  // Only the latest request may update the screen; a slow earlier response is ignored,
  // so the detail shown always belongs to the account the actions will change.
  const membersRequest = useRef(0);
  const detailRequest = useRef(0);

  async function loadMembers() {
    const request = ++membersRequest.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ search, page: String(page) });
      if (role) params.set('role', role);
      if (status) params.set('status', status);
      const members = await api<MemberPage>(`/api/admin/accounts?${params}`);
      if (request === membersRequest.current) { setResult(members); setError(''); }
    } catch (reasonValue) {
      if (request === membersRequest.current) { setResult(null); setError(handleAccountError(reasonValue)); }
    } finally { if (request === membersRequest.current) setLoading(false); }
  }
  async function loadDetail(id: string) {
    const request = ++detailRequest.current;
    setSelected(id); setDetail(null); setError('');
    try {
      const loaded = await api<Detail>(`/api/admin/accounts/${encodeURIComponent(id)}`);
      if (request !== detailRequest.current) return;
      setDetail(loaded); setPendingRole(loaded.account.role); setPendingStatus(loaded.account.status);
    } catch (reasonValue) {
      if (request === detailRequest.current) setError(handleAccountError(reasonValue));
    }
  }
  useEffect(() => { loadMembers(); }, [page, role, status]);
  useEffect(() => {
    api<Meta>('/api/accounts/meta').then(setMeta).catch(reasonValue => setMetaError(handleAccountError(reasonValue)));
  }, []);
  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (page === 1) loadMembers();
    else setPage(1);
  }
  async function updateMember(id: string, patch: { role?: Role; status?: 'active' | 'suspended' }) {
    if (reason.trim().length < 10) { setError('Provide a reason of at least 10 characters before changing access.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api<{ ok: true }>(`/api/admin/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...patch, reason: reason.trim() }) });
      setReason(''); setNotice('Account access updated with an audit reason.');
      await loadMembers();
      await loadDetail(id);
    } catch (reasonValue) { setError(handleAccountError(reasonValue)); }
    finally { setBusy(false); }
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inviteReason.trim().length < 10) { setError('Invitation reason must be at least 10 characters.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api<{ ok: true }>('/api/admin/invitations', { method: 'POST', body: JSON.stringify({ email: inviteEmail, role: inviteRole, reason: inviteReason.trim() }) });
      setInviteEmail(''); setInviteReason(''); setNotice('Invitation request recorded.');
      await loadMembers();
    } catch (reasonValue) { setError(handleAccountError(reasonValue)); }
    finally { setBusy(false); }
  }
  async function addVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    if (verifyReason.trim().length < 10) { setError('Verification reason must be at least 10 characters.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api<{ ok: true }>(`/api/admin/accounts/${encodeURIComponent(selected)}/verifications`, { method: 'POST', body: JSON.stringify({ label: verifyLabel, organizationId: verifyOrg || null, evidenceUrl: verifyUrl, reason: verifyReason.trim() }) });
      setVerifyLabel(''); setVerifyOrg(''); setVerifyUrl(''); setVerifyReason(''); setNotice('Independent verification added.');
      await loadDetail(selected);
    } catch (reasonValue) { setError(handleAccountError(reasonValue)); }
    finally { setBusy(false); }
  }
  async function revokeVerification(id: string) {
    if (!selected) return;
    const revokeReason = window.prompt('Reason for revoking this verification (at least 10 characters):');
    if (!revokeReason || revokeReason.trim().length < 10) { setError('Verification was not revoked. A reason of at least 10 characters is required.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api<{ ok: true }>(`/api/admin/accounts/${encodeURIComponent(selected)}/verifications/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ reason: revokeReason.trim() }) });
      setNotice('Independent verification revoked.');
      await loadDetail(selected);
    } catch (reasonValue) { setError(handleAccountError(reasonValue)); }
    finally { setBusy(false); }
  }
  return (
    <div className="account-shell account-wide">
      <header className="account-heading"><div><p className="account-kicker">FALK Index / Administration</p><h1 className="account-title">People and access</h1><p className="account-intro">Manage account roles, access status and independent professional verifications. Every change requires a reason.</p></div></header>
      <div className="account-stack" style={{ marginTop: 22 }}>
        {error && <div className="account-error" role="alert" tabIndex={-1}>{error}</div>}
        {metaError && <div className="account-error" role="alert">Organization options could not be loaded: {metaError} <button className="account-button secondary" type="button" onClick={() => window.location.reload()}>Retry options</button></div>}
        {notice && <div className="account-notice" role="status">{notice}</div>}
        <details className="account-panel account-details">
          <summary>Invite an account</summary>
          <form className="account-form-grid" style={{ marginTop: 18 }} onSubmit={invite}>
            <div className="account-field"><label htmlFor="invite-email">Email address</label><input id="invite-email" type="email" required value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} /></div>
            <div className="account-field"><label htmlFor="invite-role">Initial role</label><select id="invite-role" value={inviteRole} onChange={e => setInviteRole(e.target.value as Role)}>{ROLES.map(item => <option key={item}>{item}</option>)}</select></div>
            <div className="account-field" style={{ gridColumn: '1 / -1' }}><label htmlFor="invite-reason">Reason (at least 10 characters)</label><textarea id="invite-reason" required minLength={10} value={inviteReason} onChange={e => setInviteReason(e.target.value)} /></div>
            <button className="account-button" type="submit" disabled={busy}>Send invitation</button>
          </form>
        </details>
        <section className="account-panel">
          <form className="account-admin-toolbar" onSubmit={applySearch}>
            <div className="account-field"><label htmlFor="member-search">Search people</label><input id="member-search" type="search" placeholder="Name, email or username" value={search} onChange={e => setSearch(e.target.value)} /></div>
            <div className="account-field"><label htmlFor="role-filter">Role</label><select id="role-filter" value={role} onChange={e => { setRole(e.target.value); setPage(1); }}><option value="">All roles</option>{ROLES.map(item => <option key={item}>{item}</option>)}</select></div>
            <div className="account-field"><label htmlFor="status-filter">Status</label><select id="status-filter" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option></select></div>
            <button className="account-button" type="submit" disabled={loading}>Search</button>
          </form>
          {loading ? <div className="account-loading" role="status"><span className="sr-only">Loading accounts</span><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /></div> : result?.accounts.length ? <div className="account-table-wrap"><table className="account-table"><caption className="sr-only">Accounts, page {result.page}</caption><thead><tr><th scope="col">Account</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Email</th><th scope="col">Joined</th><th scope="col">Manage</th></tr></thead><tbody>{result.accounts.map(member => <tr key={member.id}><td><strong>{member.displayName || member.username || member.email}</strong><div className="account-help">{member.username ? `@${member.username}` : 'Profile setup incomplete'}</div></td><td>{member.role}</td><td>{member.status}</td><td>{member.emailVerified ? 'Verified' : 'Unverified'}</td><td>{dateLabel(member.createdAt)}</td><td><button className="account-button secondary" type="button" aria-label={`Manage ${member.displayName || member.username || member.email}`} aria-pressed={selected === member.id} onClick={() => loadDetail(member.id)}>{selected === member.id ? 'Selected' : 'Manage'}</button></td></tr>)}</tbody></table></div> : result ? <p className="account-empty">No matching accounts.</p> : <p className="account-empty">The account list could not be loaded. <button className="account-button secondary" type="button" onClick={loadMembers}>Retry</button></p>}
          <div className="account-pagination"><span className="account-help">{result ? `${result.total} accounts · page ${result.page}` : ''}</span><div className="account-actions"><button className="account-button secondary" type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => Math.max(1, value - 1))}>Previous</button><button className="account-button secondary" type="button" disabled={!result || result.page * 25 >= result.total || loading} onClick={() => setPage(value => value + 1)}>Next</button></div></div>
        </section>
        {selected && <section className="account-panel account-stack" aria-live="polite">
          <div className="account-heading"><div><p className="account-kicker">Account detail</p><h2>{detail?.account.displayName || detail?.account.email || 'Loading account…'}</h2></div><button type="button" className="account-button secondary" onClick={() => { detailRequest.current++; setSelected(null); setDetail(null); }}>Close</button></div>
          {!detail ? <div className="account-loading" role="status"><span className="sr-only">Loading account</span><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /></div> : <>
            <p className="account-meta"><span>{detail.account.email}</span><span>Role: {detail.account.role}</span><span>Status: {detail.account.status}</span></p>
            <div className="account-form-grid">
              <div className="account-field"><label htmlFor="change-role">Grant role</label><select id="change-role" value={pendingRole} onChange={e => setPendingRole(e.target.value as Role)}>{ROLES.map(item => <option key={item}>{item}</option>)}</select></div>
              <div className="account-field"><label htmlFor="change-status">Account status</label><select id="change-status" value={pendingStatus} onChange={e => setPendingStatus(e.target.value as 'active' | 'suspended')}><option value="active">Active</option><option value="suspended">Suspended</option></select></div>
              <div className="account-field" style={{ gridColumn: '1 / -1' }}><label htmlFor="change-reason">Reason for access change (at least 10 characters)</label><textarea id="change-reason" required minLength={10} value={reason} onChange={e => setReason(e.target.value)} /></div>
              <button type="button" className="account-button" disabled={busy || (pendingRole === detail.account.role && pendingStatus === detail.account.status)} onClick={() => updateMember(detail.account.id, {
                ...(pendingRole !== detail.account.role ? { role: pendingRole } : {}),
                ...(pendingStatus !== detail.account.status ? { status: pendingStatus } : {}),
              })}>Apply access change</button>
            </div>
            <div><p className="account-kicker">Independent verifications</p><h3>Evidence on record</h3></div>
            {detail.verifications.length ? <ul className="account-list">{detail.verifications.map(item => <li key={item.id}><div className="account-record"><span><strong>{item.label}</strong>{item.organizationName && <span className="account-help"> · {item.organizationName}</span>}</span><button type="button" className="account-button danger" disabled={busy} aria-label={`Revoke ${item.label}`} onClick={() => revokeVerification(item.id)}>Revoke</button></div><a href={item.evidenceUrl} target="_blank" rel="noreferrer">Open evidence</a></li>)}</ul> : <p className="account-empty">No independent verifications listed.</p>}
            <form className="account-form-grid" onSubmit={addVerification}>
              <div className="account-field"><label htmlFor="verification-label">Verification label</label><input id="verification-label" required value={verifyLabel} onChange={e => setVerifyLabel(e.target.value)} /></div>
              <div className="account-field"><label htmlFor="verification-org">Organization</label><select id="verification-org" value={verifyOrg} onChange={e => setVerifyOrg(e.target.value)}><option value="">No organization</option>{meta.organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select></div>
              <div className="account-field"><label htmlFor="verification-url">Evidence URL</label><input id="verification-url" required type="url" placeholder="https://" value={verifyUrl} onChange={e => setVerifyUrl(e.target.value)} /></div>
              <div className="account-field"><label htmlFor="verification-reason">Reason (at least 10 characters)</label><input id="verification-reason" required minLength={10} value={verifyReason} onChange={e => setVerifyReason(e.target.value)} /></div>
              <button className="account-button" type="submit" disabled={busy}>Add verification</button>
            </form>
            <div><p className="account-kicker">Audit trail</p><ul className="account-list">{detail.audit.map(item => <li key={item.id}><strong>{item.action}</strong><p className="account-help">{dateLabel(item.createdAt)} · {item.reason}</p></li>)}</ul></div>
          </>}
        </section>}
      </div>
    </div>
  );
}

function AdminSession() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="account-shell"><p role="status">Checking your session…</p></div>;
  if (!isSignedIn) return <div className="account-shell"><h1 className="account-title">Administration</h1><p>Sign in with an administrator account to manage people and access.</p><a className="account-button" href="/sign-in?redirect_url=%2Fadmin%2Fusers">Sign in</a></div>;
  return <AdminConsole />;
}

export default function AdminUsersApp() {
  return <AuthProvider><AdminSession /></AuthProvider>;
}
