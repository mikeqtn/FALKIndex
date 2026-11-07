import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@clerk/react';
import type { Account } from '../../accounts/contracts';
import { NEW_BRAND_KINDS, SOURCE_TYPES, newWatchInput } from '../../accounts/contracts';
import { api, handleAccountError } from './api';
import { AuthProvider } from './AuthProvider';

type SourceType = typeof SOURCE_TYPES[number];
type Option = { value: string; label: string };
interface Props {
  organizations: { id: string; name: string }[];
  records: { id: string; brand: string; brandName: string; model: string; variant: string }[];
  dimensions: Option[];
  sourceTypes: Option[];
}
type Claim = { statement: string; excerpt: string; url: string; title: string; sourceType: SourceType | ''; dimensions: string[] };
const NEW = '__new__';
const blankClaim: Claim = { statement: '', excerpt: '', url: '', title: '', sourceType: '', dimensions: [] };
const blank = {
  brandId: '', brandName: '', brandKind: 'brand' as typeof NEW_BRAND_KINDS[number], country: '', website: '',
  model: '', reference: '', generation: '', caliber: '', productionStart: '', productionEnd: '', notes: '',
  claims: [blankClaim], explanation: '',
};
type Form = typeof blank;
const kindLabels: Record<typeof NEW_BRAND_KINDS[number], string> = { brand: 'Brand', atelier: 'Atelier or workshop', individual: 'Individual watchmaker' };

function toInput(f: Form) {
  const year = (v: string) => v.trim() ? { value: Number(v.trim()) } : null;
  const start = year(f.productionStart), end = year(f.productionEnd);
  return {
    brand: f.brandId === NEW ? { name: f.brandName, kind: f.brandKind, country: f.country.trim().toUpperCase(), website: f.website.trim() } : { id: f.brandId },
    model: f.model, reference: f.reference, generation: f.generation, caliber: f.caliber, notes: f.notes,
    ...(start ? { productionStart: start.value } : {}), ...(end ? { productionEnd: end.value } : {}),
    claims: f.claims.map(c => ({ ...c, url: c.url.trim() })),
    explanation: f.explanation,
  };
}

/** Plainer wording for the schema's generic messages; the contract's own messages pass through. */
function message(path: string, code: string, text: string) {
  if (path === 'brand.id') return 'Choose the brand, or choose “Brand not listed”.';
  if (path === 'brand.name' && code === 'too_small') return 'Enter the brand’s name.';
  if (path === 'model' && code === 'too_small') return 'Enter the model name.';
  if (/^production/.test(path) && code !== 'custom') return 'Enter a year as four digits, e.g. 2019.';
  if (/sourceType$/.test(path)) return 'Choose the kind of source.';
  if (/url$|website$/.test(path)) return 'Enter the full page address, starting with https://.';
  return text;
}

const fieldId = (path: string) => `nw-${path.replaceAll('.', '-')}`;
const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 1);

/** Published records that share the brand, or a model word, with what is being typed. */
function similarRecords(records: Props['records'], f: Form) {
  const model = words(f.model);
  const brandName = f.brandId === NEW ? words(f.brandName) : [];
  const hasBrand = (f.brandId && f.brandId !== NEW) || brandName.length > 0;
  if (!hasBrand && !model.length) return [];
  return records.filter(r => {
    const sameBrand = f.brandId && f.brandId !== NEW ? r.brand === f.brandId : brandName.length > 0 && brandName.every(w => words(r.brandName).includes(w));
    const modelHit = model.some(w => words(`${r.model} ${r.variant}`).includes(w));
    return hasBrand ? sameBrand && (!model.length || modelHit) : modelHit;
  }).slice(0, 6);
}

function Proposal({ organizations, records, dimensions, sourceTypes }: Props) {
  const [form, setForm] = useState<Form>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [focusError, setFocusError] = useState(0);
  useEffect(() => { if (focusError) document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); }, [focusError]);
  useEffect(() => { if (sent) document.getElementById('nw-sent')?.focus(); }, [sent]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(current => ({ ...current, [key]: value }));
  const setClaim = (i: number, patch: Partial<Claim>) => setForm(current => ({ ...current, claims: current.claims.map((c, j) => j === i ? { ...c, ...patch } : c) }));
  const field = (path: string, help?: string) => ({
    id: fieldId(path),
    'aria-invalid': errors[path] ? true : undefined,
    'aria-describedby': [errors[path] && `${fieldId(path)}-err`, help].filter(Boolean).join(' ') || undefined,
  });
  const err = (path: string) => errors[path] && <small id={`${fieldId(path)}-err`} className="account-field-error">{errors[path]}</small>;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const parsed = newWatchInput.safeParse(toInput(form));
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.');
        found[path] ??= message(path, issue.code, issue.message);
      }
      setErrors(found);
      setError('Some fields need attention. Each one is marked below.');
      setFocusError(n => n + 1);
      return;
    }
    setErrors({}); setBusy(true);
    try {
      const { submission } = await api<{ submission: { id: string; proposedId: string } }>('/api/contributions/watches', { method: 'POST', body: JSON.stringify(parsed.data) });
      setSent(submission.proposedId);
    } catch (reason) {
      setError(handleAccountError(reason));
      document.getElementById('nw-error')?.focus();
    } finally { setBusy(false); }
  }

  if (sent) return <div id="nw-sent" className="account-panel account-stack" role="status" tabIndex={-1}>
    <h2>Proposal sent</h2>
    <p>An editor will check your facts against their sources. If it is accepted, the watch goes live as a new record at <code>/records/{sent}/</code>, with no scores until a later reviewed version adds them.</p>
    <p className="account-help">Proposed record id: <code>{sent}</code>.</p>
    <div className="account-actions"><a className="account-button secondary" href="/records/">Back to records</a></div>
  </div>;

  const similar = similarRecords(records, form);
  return <form className="account-stack" onSubmit={submit} noValidate>
    {error && <div id="nw-error" className="account-error" role="alert" tabIndex={-1}>{error}</div>}

    <section className="account-panel account-stack" aria-labelledby="nw-watch-heading">
      <h2 id="nw-watch-heading">The watch</h2>
      <div className="account-form-grid">
        <div className="account-field"><label htmlFor={fieldId('brand.id')}>Brand</label>
          <select {...field('brand.id')} value={form.brandId} onChange={e => set('brandId', e.target.value)}>
            <option value="">Choose a brand</option>
            {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            <option value={NEW}>Brand not listed</option>
          </select>{err('brand.id')}</div>
        <div className="account-field"><label htmlFor={fieldId('model')}>Model</label>
          <input {...field('model')} maxLength={120} value={form.model} onChange={e => set('model', e.target.value)} />{err('model')}</div>
      </div>
      {form.brandId === NEW && <div className="account-details account-form-grid">
        <div className="account-field"><label htmlFor={fieldId('brand.name')}>Brand name</label>
          <input {...field('brand.name')} maxLength={120} value={form.brandName} onChange={e => set('brandName', e.target.value)} />{err('brand.name')}</div>
        <div className="account-field"><label htmlFor={fieldId('brand.kind')}>What kind of maker</label>
          <select {...field('brand.kind')} value={form.brandKind} onChange={e => set('brandKind', e.target.value as Form['brandKind'])}>
            {NEW_BRAND_KINDS.map(k => <option key={k} value={k}>{kindLabels[k]}</option>)}
          </select>{err('brand.kind')}</div>
        <div className="account-field"><label htmlFor={fieldId('brand.country')}>Country (optional)</label>
          <input {...field('brand.country', 'nw-country-help')} maxLength={2} autoCapitalize="characters" value={form.country} onChange={e => set('country', e.target.value)} />
          <small id="nw-country-help">Two-letter code, e.g. CH or DE.</small>{err('brand.country')}</div>
        <div className="account-field"><label htmlFor={fieldId('brand.website')}>Website (optional)</label>
          <input {...field('brand.website')} type="url" placeholder="https://" value={form.website} onChange={e => set('website', e.target.value)} />{err('brand.website')}</div>
      </div>}
      {similar.length > 0 && <div className="account-notice" role="status">
        <p><b>Already in FALK?</b> These records look similar. If yours is one of them, suggest an edit instead of proposing it again.</p>
        <ul className="nw-similar">{similar.map(r => <li key={r.id}><a href={`/records/${r.id}/`}>{r.brandName} {r.model}</a>{r.variant && <span className="account-help"> · {r.variant}</span>} · <a href={`/corrections/?record=${encodeURIComponent(r.id)}`}>Suggest an edit</a></li>)}</ul>
      </div>}
      <div className="account-form-grid">
        <div className="account-field"><label htmlFor={fieldId('reference')}>Reference (optional)</label>
          <input {...field('reference')} maxLength={120} value={form.reference} onChange={e => set('reference', e.target.value)} />{err('reference')}</div>
        <div className="account-field"><label htmlFor={fieldId('generation')}>Generation (optional)</label>
          <input {...field('generation')} maxLength={120} value={form.generation} onChange={e => set('generation', e.target.value)} />{err('generation')}</div>
        <div className="account-field"><label htmlFor={fieldId('caliber')}>Caliber (optional)</label>
          <input {...field('caliber')} maxLength={120} value={form.caliber} onChange={e => set('caliber', e.target.value)} />{err('caliber')}</div>
        <div className="account-form-grid">
          <div className="account-field"><label htmlFor={fieldId('productionStart')}>Made from (optional)</label>
            <input {...field('productionStart')} inputMode="numeric" maxLength={4} placeholder="Year" value={form.productionStart} onChange={e => set('productionStart', e.target.value)} />{err('productionStart')}</div>
          <div className="account-field"><label htmlFor={fieldId('productionEnd')}>Made until (optional)</label>
            <input {...field('productionEnd', 'nw-end-help')} inputMode="numeric" maxLength={4} placeholder="Year" value={form.productionEnd} onChange={e => set('productionEnd', e.target.value)} />
            <small id="nw-end-help">Leave blank if still made.</small>{err('productionEnd')}</div>
        </div>
      </div>
      <div className="account-field"><label htmlFor={fieldId('notes')}>Notes (optional)</label>
        <textarea {...field('notes')} maxLength={2000} value={form.notes} onChange={e => set('notes', e.target.value)} />{err('notes')}</div>
    </section>

    <section className="account-panel account-stack" aria-labelledby="nw-facts-heading">
      <div><h2 id="nw-facts-heading">Sourced facts</h2>
        <p className="account-help">One fact per source, about how the watch is made. State what the source says, not your judgement: “Nomos states the escapement is made in Glashütte”. Link the exact page, not a home page. Scores and the archetype are left to editors.</p></div>
      {err('claims')}
      {form.claims.map((c, i) => {
        const p = (key: string) => `claims.${i}.${key}`;
        return <fieldset key={i} className="account-details account-stack nw-claim">
          <legend className="account-label">Fact {i + 1}</legend>
          <div className="account-field"><label htmlFor={fieldId(p('statement'))}>What the source says</label>
            <textarea {...field(p('statement'))} maxLength={1000} value={c.statement} onChange={e => setClaim(i, { statement: e.target.value })} />{err(p('statement'))}</div>
          <div className="account-field"><label htmlFor={fieldId(p('excerpt'))}>Excerpt (optional)</label>
            <textarea {...field(p('excerpt'), `nw-excerpt-help-${i}`)} maxLength={1000} value={c.excerpt} onChange={e => setClaim(i, { excerpt: e.target.value })} />
            <small id={`nw-excerpt-help-${i}`}>A short quote copied word for word from the page. Never retype it from memory.</small>{err(p('excerpt'))}</div>
          <div className="account-form-grid">
            <div className="account-field"><label htmlFor={fieldId(p('url'))}>Source page address</label>
              <input {...field(p('url'))} type="url" placeholder="https://" value={c.url} onChange={e => setClaim(i, { url: e.target.value })} />{err(p('url'))}</div>
            <div className="account-field"><label htmlFor={fieldId(p('title'))}>Source title (optional)</label>
              <input {...field(p('title'))} maxLength={300} value={c.title} onChange={e => setClaim(i, { title: e.target.value })} />{err(p('title'))}</div>
            <div className="account-field"><label htmlFor={fieldId(p('sourceType'))}>Kind of source</label>
              <select {...field(p('sourceType'))} value={c.sourceType} onChange={e => setClaim(i, { sourceType: e.target.value as SourceType })}>
                <option value="">Choose</option>
                {sourceTypes.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>{err(p('sourceType'))}</div>
          </div>
          <fieldset className="account-field nw-dimensions" {...field(p('dimensions'))} tabIndex={-1}>
            <legend className="account-label">What it bears on</legend>
            <div className="account-toggles">{dimensions.map(d => <label key={d.value} className="account-toggle"><input type="checkbox" checked={c.dimensions.includes(d.value)}
              onChange={e => setClaim(i, { dimensions: e.target.checked ? [...c.dimensions, d.value] : c.dimensions.filter(x => x !== d.value) })} />{d.label}</label>)}</div>
            {err(p('dimensions'))}
          </fieldset>
          {form.claims.length > 1 && <div className="account-actions"><button type="button" className="account-button secondary" onClick={() => set('claims', form.claims.filter((_, j) => j !== i))}>Remove fact {i + 1}</button></div>}
        </fieldset>;
      })}
      {form.claims.length < 20 && <div className="account-actions"><button type="button" className="account-button secondary" onClick={() => set('claims', [...form.claims, blankClaim])}>Add another fact</button></div>}
    </section>

    <section className="account-panel account-stack" aria-labelledby="nw-why-heading">
      <h2 id="nw-why-heading">Why it belongs</h2>
      <div className="account-field"><label htmlFor={fieldId('explanation')}>Why should FALK list this watch?</label>
        <textarea {...field('explanation')} maxLength={5000} value={form.explanation} onChange={e => set('explanation', e.target.value)} />{err('explanation')}</div>
      <p className="account-help">An editor checks every fact against its source. If accepted, the record is published under your name with no scores until a later reviewed version adds them. By sending, you agree to the <a href="/terms/">terms of use</a>.</p>
      <div className="account-actions"><button className="account-button" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send proposal'}</button></div>
    </section>
  </form>;
}

function Gate(props: Props) {
  const { isLoaded, isSignedIn } = useAuth();
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isSignedIn) return;
    api<{ account: Account }>('/api/account').then(r => setAccount(r.account)).catch(e => setError(handleAccountError(e)));
  }, [isSignedIn]);
  if (!isLoaded) return <p role="status">Checking your session…</p>;
  if (!isSignedIn) return <div className="account-panel account-stack">
    <p>Proposing a watch needs a FALK Index account with a verified email, so editors can credit the record and follow up on its sources.</p>
    <div className="account-actions"><a className="account-button" href="/sign-in?redirect_url=%2Frecords%2Fnew%2F">Sign in</a></div>
  </div>;
  if (error) return <div className="account-error" role="alert">{error}</div>;
  if (!account) return <div className="account-loading" role="status"><span className="sr-only">Loading your account</span><div className="account-skeleton" aria-hidden="true" /><div className="account-skeleton" aria-hidden="true" /></div>;
  if (account.status === 'suspended') return <div className="account-error" role="alert">This account is suspended, so it can’t propose watches.</div>;
  if (!account.emailVerified) return <div className="account-error" role="alert">Verify your email address before proposing a watch. You can check it on your <a href="/account">account page</a>.</div>;
  return <Proposal {...props} />;
}

export default function NewWatchApp(props: Props) {
  return <AuthProvider><div className="account-shell">
    <header className="account-heading"><div><p className="account-kicker">FALK Index / Contribute</p><h1 className="account-title">Propose a new watch</h1>
      <p className="account-intro">Tell us about a watch FALK doesn’t list yet, with at least one sourced fact about how it is made. An editor reviews every proposal before it goes live.</p></div></header>
    <div className="account-stack" style={{ marginTop: 22 }}><Gate {...props} /></div>
  </div></AuthProvider>;
}
