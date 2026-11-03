// Scripts that must run inline, in place, before the page paints. Astro does not hash is:inline scripts for the
// Content Security Policy, so they live here: Base.astro prints them and astro.config.mjs hashes the same strings.
// Edit them freely; the hash follows the text. Plain .mjs so the config can import it without a build step.

/** Apply a saved theme before first paint; with no saved choice the system setting applies. */
export const THEME_SCRIPT = `try { const t = localStorage.getItem('falk-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch {}`;

/** The menu renders open so links work without script; below 1100px it folds behind "Menu". */
export const MENU_SCRIPT = `(() => {
  const menu = document.querySelector('.nav-menu'), wide = matchMedia('(min-width: 1100px)');
  const fit = () => { menu.open = wide.matches; };
  fit(); wide.addEventListener('change', fit);
})();`;

export const INLINE_SCRIPTS = [THEME_SCRIPT, MENU_SCRIPT];

// Clerk Protect (bot protection on sign-in and sign-up). It probes its hosts on several ports (443, 8443, 18443, 2082,
// 992), hence the :* on connect-src. Shared by astro.config.mjs and Base.astro, which replaces connect-src per request.
export const CLERK_PROTECT_SCRIPTS = ['https://cdn.protect.clerk.com', 'https://*.client.protect.clerk.com'];
export const CLERK_PROTECT_CONNECT = 'https://*.client.protect.clerk.com:*';
