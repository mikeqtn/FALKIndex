// Scripts that must run inline, in place, before the page paints. Astro does not hash is:inline scripts for the
// Content Security Policy, so they live here: Base.astro prints them and astro.config.mjs hashes the same strings.
// Edit them freely; the hash follows the text. Plain .mjs so the config can import it without a build step.

/**
 * Apply a saved theme before first paint; with no saved choice the system setting applies. The cookie is shared by
 * falkindex.com and forum.falkindex.com, whose localStorage is separate; localStorage covers browsers that block cookies.
 */
export const THEME_SCRIPT = `try { const t = /(?:^|; )falk-theme=(light|dark)/.exec(document.cookie)?.[1] ?? localStorage.getItem('falk-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch {}`;

/**
 * Remember a chosen theme on both sites. Other hosts (local development, the Replit preview) keep it to themselves.
 * @param {string} theme
 * @param {{ hostname: string, protocol: string }} [where]
 */
export function saveTheme(theme, { hostname, protocol } = location) {
  const domain = /(^|\.)falkindex\.com$/.test(hostname) ? '; Domain=falkindex.com' : '';
  const secure = protocol === 'https:' ? '; Secure' : '';
  try { document.cookie = `falk-theme=${theme}; Path=/; Max-Age=31536000${domain}; SameSite=Lax${secure}`; } catch {}
  try { localStorage.setItem('falk-theme', theme); } catch {}
}

/** The menu renders open so links work without script; below 1200px it folds behind "Menu". */
export const MENU_SCRIPT = `(() => {
  const menu = document.querySelector('.nav-menu'), wide = matchMedia('(min-width: 1200px)');
  const fit = () => { menu.open = wide.matches; };
  fit(); wide.addEventListener('change', fit);
})();`;

/**
 * Evidence renders every dimension open so it all reads without script. Before paint, this picks the one to show:
 * on wide screens the published evidence shows the linked (or first) dimension and marks it in the page's picker;
 * on narrow screens, and for a draft, only the linked one stays open. EvidenceList's own script handles clicks after that.
 */
export const EVIDENCE_SCRIPT = `(() => {
  const ev = document.currentScript.previousElementSibling, panels = [...ev.querySelectorAll('.ev-panel')];
  const hit = panels.find(p => '#' + p.id === location.hash);
  ev.classList.add('ev-js');
  if (ev.classList.contains('pick') && matchMedia('(min-width: 1024px)').matches) {
    const cur = hit ?? panels[0];
    cur.classList.add('is-current');
    document.querySelectorAll('[data-picker] a[href="#' + cur.id + '"]').forEach(a => a.setAttribute('aria-current', 'true'));
  } else { panels.forEach(p => { p.open = p === hit; }); hit?.classList.add('is-current'); }
})();`;

/**
 * Crossing between FALK Index and the forum. In production they are different hosts (falkindex.com and
 * forum.falkindex.com), so the browser's view transitions, which are same-origin only, cannot animate the change.
 * Instead the page you leave dissolves to its own background, and the page you arrive on rises in from the same
 * background (shared.css). Both sites use one page colour and share the theme cookie, so the two halves read as
 * one fade. In development the forum lives under /forum on the same host, so the path decides which site a URL is.
 * The click is not held back: the page you leave stays on screen while the next one loads, so it fades during the
 * request rather than before it. The arrival flag stays on the page, which keeps a page's own entrance (the home
 * page's shutter, the sections rising in) from playing a second fade after this one.
 * Skipped under reduced motion; a page restored from the back/forward cache drops the fade at once.
 */
export const SITE_JUMP_SCRIPT = `(() => {
  const root = h => h.split('.').slice(-2).join('.');
  const forumPath = p => p === '/forum' || p.startsWith('/forum/');
  const crosses = u => u.host !== location.host ? root(u.hostname) === root(location.hostname) : forumPath(u.pathname) !== forumPath(location.pathname);
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const html = document.documentElement;
  try { const r = document.referrer && new URL(document.referrer); if (r && crosses(r) && !calm()) { html.dataset.arriving = ''; } } catch {}
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
    const u = new URL(a.href, location.href);
    if (/^https?:$/.test(u.protocol) && crosses(u) && !calm()) html.dataset.leaving = '';
  });
  addEventListener('pageshow', () => delete html.dataset.leaving);
})();`;

export const INLINE_SCRIPTS = [THEME_SCRIPT, MENU_SCRIPT, EVIDENCE_SCRIPT, SITE_JUMP_SCRIPT];

// Clerk Protect (bot protection on sign-in and sign-up). It probes its hosts on several ports (443, 8443, 18443, 2082,
// 992), hence the :* on connect-src. Shared by astro.config.mjs and Base.astro, which replaces connect-src per request.
export const CLERK_PROTECT_SCRIPTS = ['https://cdn.protect.clerk.com', 'https://*.client.protect.clerk.com'];
export const CLERK_PROTECT_CONNECT = 'https://*.client.protect.clerk.com:*';
