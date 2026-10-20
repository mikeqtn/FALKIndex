import { SignIn, SignUp } from '@clerk/react';
import { AuthProvider } from './AuthProvider';

export function SignInPage() {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return (
    <AuthProvider>
      <section className="account-auth-page">
        <div>
          <div className="account-auth-intro">
            <a href="/"><img className="account-brand" src="/logo.svg" alt="FALK Index" /></a>
            <p className="account-kicker">Reader account</p>
            <p className="account-help">Sign in to maintain your profile and contribute to the evidence record. The catalogue remains open to everyone.</p>
          </div>
          <SignIn routing="path" path={`${base}/sign-in`} signUpUrl={`${base}/sign-up`} />
        </div>
      </section>
    </AuthProvider>
  );
}

export function SignUpPage() {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return (
    <AuthProvider>
      <section className="account-auth-page">
        <div>
          <div className="account-auth-intro">
            <a href="/"><img className="account-brand" src="/logo.svg" alt="FALK Index" /></a>
            <p className="account-kicker">Create an account</p>
            <p className="account-help">An account lets you maintain an author profile. It does not gate public records or confer editorial authority.</p>
          </div>
          <SignUp routing="path" path={`${base}/sign-up`} signInUrl={`${base}/sign-in`} />
        </div>
      </section>
    </AuthProvider>
  );
}
