import { ClerkProvider } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import type { ReactNode } from 'react';
import '../../styles/accounts.css';

// Colours come from the site tokens so the card follows light and dark mode.
const appearance = {
  theme: 'simple' as const,
  options: {
    logoPlacement: 'none' as const,
  },
  variables: {
    colorPrimary: 'var(--c-action)',
    colorForeground: 'var(--c-ink)',
    colorMutedForeground: 'var(--c-ink-2)',
    colorDanger: 'var(--c-action)',
    colorBackground: 'var(--c-surface)',
    colorInput: 'var(--c-page)',
    colorInputForeground: 'var(--c-ink)',
    colorNeutral: 'var(--c-edge)',
    fontFamily: "'Archivo Variable', system-ui, sans-serif",
    borderRadius: '3px',
  },
  elements: {
    rootBox: { width: '100%', minWidth: 0, display: 'flex', justifyContent: 'center' },
    cardBox: { width: 'min(440px, calc(100vw - 32px))', minWidth: 0, maxWidth: '100%', overflow: 'hidden', background: 'var(--c-surface)', borderRadius: '6px', boxShadow: '0 2px 0 color-mix(in srgb, var(--c-ink) 7%, transparent)' },
    card: { background: 'transparent', border: '0', boxShadow: 'none' },
    footer: { background: 'transparent', border: '0', boxShadow: 'none' },
    headerTitle: { color: 'var(--c-ink)', fontWeight: 650 },
    headerSubtitle: { color: 'var(--c-ink-2)' },
    socialButtonsBlockButtonText: { color: 'var(--c-ink)', fontWeight: 550 },
    formFieldLabel: { color: 'var(--c-ink)', fontWeight: 600 },
    footerActionLink: { color: 'var(--c-action)', fontWeight: 650 },
    footerActionText: { color: 'var(--c-ink-2)' },
    dividerText: { color: 'var(--c-ink-2)' },
    identityPreviewEditButton: { color: 'var(--c-action)' },
    formFieldSuccessText: { color: 'var(--auth-success)' },
    alertText: { color: 'var(--c-ink)' },
    socialButtonsBlockButton: { border: 'var(--edge)', background: 'var(--c-page)', color: 'var(--c-ink)' },
    formButtonPrimary: { background: 'var(--c-action)', color: 'var(--c-ink-inverse)', borderRadius: '3px' },
    formFieldInput: { minHeight: '44px', border: '1px solid var(--c-ink-2)', background: 'var(--auth-field)', color: 'var(--c-ink)', font: '400 16px/1.3 var(--f-sans)', paddingInlineStart: '12px' },
    footerAction: { color: 'var(--c-ink-2)' },
    dividerLine: { background: 'var(--c-edge)' },
    alert: { background: 'var(--c-gilt-tint)' },
    otpCodeFieldInput: { border: '1px solid var(--c-ink-2)', background: 'var(--auth-field)', color: 'var(--c-ink)' },
    formFieldRow: { color: 'var(--c-ink)' },
    main: { color: 'var(--c-ink)' },
  },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const clerkPubKey = publishableKeyFromHost(
    window.location.hostname,
    import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
  );
  const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={appearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to your FALK Index account' } },
        signUp: { start: { title: 'Join the Index', subtitle: 'Create an account to contribute context and expertise' } },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
