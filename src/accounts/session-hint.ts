import { sharedCookieDomain } from './clerk-host.ts';

// A hint that this browser is signed in, for the server pages that draw the account menu before Clerk loads. Clerk's
// own __client_uat is not always readable on the forum's subdomain, so after signing in on falkindex.com the forum
// drew "Sign in" until it was clicked. Every Clerk island (AuthProvider) sets this when Clerk says signed in and clears
// it when Clerk says signed out, on the domain both sites share. It only chooses what to draw; the server checks the
// real session for anything it does.
export const SESSION_HINT = 'falk_signed_in';
const MONTH = 60 * 60 * 24 * 30;

function write(value: string, maxAge: number) {
  const domain = sharedCookieDomain(location.hostname);
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  try { document.cookie = `${SESSION_HINT}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${domain ? `; Domain=${domain}` : ''}${secure}`; } catch {}
}
export const setSessionHint = (signedIn: boolean) => signedIn ? write('1', MONTH) : write('', 0);
