import { SignIn, SignUp } from '@clerk/react';
import { AuthProvider, authCardAppearance } from './AuthProvider';

export function SignInPage() {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return (
    <AuthProvider>
      <section className="account-auth-page">
        <div>
          <div className="account-auth-intro">
            <a className="account-brand" href="/">FALK Index</a>
            <p className="account-kicker">Reader account</p>
            <p className="account-help">Sign in to maintain your profile and contribute to the evidence record. The catalogue remains open to everyone.</p>
          </div>
          <SignIn routing="path" path={`${base}/sign-in`} signUpUrl={`${base}/sign-up`} appearance={authCardAppearance} />
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
            <a className="account-brand" href="/">FALK Index</a>
            <p className="account-kicker">Create an account</p>
            <p className="account-help">An account lets you maintain an author profile. It does not gate public records or confer editorial authority. By creating one you agree to the <a href="/terms/">terms of use</a> and confirm you are 13 or older (16 in the EU or UK).</p>
          </div>
          <SignUp routing="path" path={`${base}/sign-up`} signInUrl={`${base}/sign-in`} appearance={authCardAppearance} />
        </div>
      </section>
    </AuthProvider>
  );
}
