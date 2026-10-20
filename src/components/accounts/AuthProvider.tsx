import { ClerkProvider } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import type { ReactNode } from 'react';
import '../../styles/accounts.css';

const appearance = {
  theme: 'simple' as const,
  options: {
    logoPlacement: 'none' as const,
  },
  variables: {
    colorPrimary: '#9C1A33',
    colorForeground: '#14233F',
    colorMutedForeground: '#4A5361',
    colorDanger: '#9C1A33',
    colorBackground: '#F6F7F8',
    colorInput: '#E3E6EA',
    colorInputForeground: '#14233F',
    colorNeutral: '#C4CAD3',
    fontFamily: "'Archivo Variable', system-ui, sans-serif",
    borderRadius: '3px',
  },
  elements: {
    rootBox: { width: '100%', minWidth: 0, display: 'flex', justifyContent: 'center' },
    cardBox: { width: 'min(440px, calc(100vw - 32px))', minWidth: 0, maxWidth: '100%', overflow: 'hidden', background: '#F6F7F8', borderRadius: '6px', boxShadow: '0 2px 0 rgba(20,35,63,.07)' },
    card: { background: 'transparent', border: '0', boxShadow: 'none' },
    footer: { background: 'transparent', border: '0', boxShadow: 'none' },
    headerTitle: { color: '#14233F', fontWeight: 650 },
    headerSubtitle: { color: '#4A5361' },
    socialButtonsBlockButtonText: { color: '#14233F', fontWeight: 550 },
    formFieldLabel: { color: '#14233F', fontWeight: 600 },
    footerActionLink: { color: '#9C1A33', fontWeight: 650 },
    footerActionText: { color: '#4A5361' },
    dividerText: { color: '#4A5361' },
    identityPreviewEditButton: { color: '#9C1A33' },
    formFieldSuccessText: { color: '#365A45' },
    alertText: { color: '#14233F' },
    socialButtonsBlockButton: { border: '1px solid #C4CAD3', background: '#E3E6EA', color: '#14233F' },
    formButtonPrimary: { background: '#9C1A33', color: '#F6F7F8', borderRadius: '3px' },
    formFieldInput: { minHeight: '44px', border: '1px solid #4A5361', background: '#FFFFFF', color: '#14233F', fontSize: '16px' },
    footerAction: { color: '#4A5361' },
    dividerLine: { background: '#C4CAD3' },
    alert: { background: '#F1E7D2' },
    otpCodeFieldInput: { border: '1px solid #4A5361', background: '#FFFFFF', color: '#14233F' },
    formFieldRow: { color: '#14233F' },
    main: { color: '#14233F' },
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
