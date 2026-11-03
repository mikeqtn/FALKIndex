// One sign-in across falkindex.com and its subdomains. Clerk shares a session across subdomains only when they
// use the same frontend API, so a subdomain such as the forum uses the main site's key and proxy. The browser
// and the server both read this, so they cannot disagree. Every other host (previews, local) is left alone.
const ROOT = 'falkindex.com';
const hostname = (host: string) => host.toLowerCase().replace(/:\d+$/, '');
const isSubdomain = (host: string) => hostname(host).endsWith(`.${ROOT}`);

/** The host whose Clerk key this host uses. */
export const clerkHostFor = (host: string) => isSubdomain(host) ? ROOT : host;
/** The Clerk proxy this host must use, when it isn't the default for the host. */
export const clerkProxyFor = (host: string) => isSubdomain(host) ? `https://${ROOT}/api/__clerk` : undefined;
