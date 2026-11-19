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

/** The menu renders open so links work without script; below 1100px it folds behind "Menu". */
export const MENU_SCRIPT = `(() => {
  const menu = document.querySelector('.nav-menu'), wide = matchMedia('(min-width: 1100px)');
  const fit = () => { menu.open = wide.matches; };
  fit(); wide.addEventListener('change', fit);
})();`;

/**
 * Evidence renders every dimension open so it all reads without script. Before paint, this picks the one to show:
 * on wide screens the linked (or first) dimension beside the list, on narrow ones only the linked one stays open.
 * EvidenceList's own script handles clicks after that.
 */
export const EVIDENCE_SCRIPT = `(() => {
  const ev = document.currentScript.previousElementSibling, panels = [...ev.querySelectorAll('.ev-panel')];
  const hit = panels.find(p => '#' + p.id === location.hash);
  ev.classList.add('ev-js');
  if (matchMedia('(min-width: 1024px)').matches) (hit ?? panels[0]).classList.add('is-current');
  else { panels.forEach(p => { p.open = p === hit; }); hit?.classList.add('is-current'); }
})();`;

export const INLINE_SCRIPTS = [THEME_SCRIPT, MENU_SCRIPT, EVIDENCE_SCRIPT];

// Clerk Protect (bot protection on sign-in and sign-up). It probes its hosts on several ports (443, 8443, 18443, 2082,
// 992), hence the :* on connect-src. Shared by astro.config.mjs and Base.astro, which replaces connect-src per request.
export const CLERK_PROTECT_SCRIPTS = ['https://cdn.protect.clerk.com', 'https://*.client.protect.clerk.com'];
export const CLERK_PROTECT_CONNECT = 'https://*.client.protect.clerk.com:*';
