import { useState, type FormEvent } from 'react';
import { ArrowRight, LockKeyhole, Mail, ShieldCheck, Store } from 'lucide-react';
import { FadeUp } from './FadeUp';

export type AuthMode = 'sign_in' | 'sign_up';

type AuthScreenProps = {
  configured: boolean;
  busy: boolean;
  googleBusy: boolean;
  error: string;
  notice: string;
  onSubmit: (mode: AuthMode, email: string, password: string) => Promise<void>;
  onGoogleSignIn: () => Promise<void>;
};

const heroWords = 'WE BUILD END-TO-END AI AUTOMATION SYSTEMS.'.split(' ');

function GoogleMark() {
  return (
    <svg className="google-mark" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.76 7.18l7.73 6C44.42 38.06 46.98 31.92 46.98 24.55Z" />
      <path fill="#FBBC05" d="M10.53 28.59a14.4 14.4 0 0 1 0-9.18l-7.98-6.2a23.9 23.9 0 0 0 0 21.58l7.98-6.2Z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.94-2.13 15.92-5.8l-7.73-6c-2.14 1.44-4.88 2.3-8.19 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.2C6.51 42.62 14.62 48 24 48Z" />
    </svg>
  );
}

export default function AuthScreen({
  configured,
  busy,
  googleBusy,
  error,
  notice,
  onSubmit,
  onGoogleSignIn,
}: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit(mode, email.trim(), password);
  };

  const isSignUp = mode === 'sign_up';

  return (
    <main className="auth-page">
      <video
        className="auth-background-video"
        autoPlay
        muted
        loop
        playsInline
        aria-hidden="true"
        tabIndex={-1}
      >
        <source
          src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260514_135830_bb6491d1-9b66-4aec-9722-13b4dfe3fb46.mp4"
          type="video/mp4"
        />
      </video>

      <header className="auth-page-brand">
        <span className="auth-brand-mark"><Store size={21} strokeWidth={2.2} /></span>
        <span className="auth-brand-copy">
          <strong>voice of store</strong>
          <small>OPERATIONS INTELLIGENCE</small>
        </span>
      </header>

      <section className="auth-landing-section" aria-labelledby="landing-heading">
        <div className="auth-content-block">
          <div className="auth-hero-kicker"><span /> RETAIL OPERATIONS · MADE ACTIONABLE</div>
          <h2 id="landing-heading" className="auth-hero-heading">
            {heroWords.map((word, index) => (
              <FadeUp
                as="span"
                className="landing-word"
                delay={0.15 + index * 0.08}
                key={`${word}-${index}`}
                y={32}
              >
                {word}
              </FadeUp>
            ))}
          </h2>
          <FadeUp as="p" className="auth-hero-description" delay={0.9} y={24}>
            We provide all-in-one AI automation services in one place.
          </FadeUp>

          <div className="auth-card" aria-labelledby="auth-title">
            <div className="auth-card-heading">
              <div>
                <div className="auth-card-kicker"><span /> STORE OPERATIONS WORKSPACE</div>
                <h1 id="auth-title">{isSignUp ? 'Create your account' : 'Welcome back'}</h1>
                <p className="auth-card-description">
                  {isSignUp
                    ? 'Create a secure account to access your authorized store workspace.'
                    : 'Sign in to review feedback and manage incidents for your authorized stores.'}
                </p>
              </div>
              <span className="auth-card-shield"><ShieldCheck size={19} /></span>
            </div>

            <div className="auth-mode-tabs" role="tablist" aria-label="Account access">
              <button
                aria-selected={!isSignUp}
                className={!isSignUp ? 'active' : ''}
                onClick={() => setMode('sign_in')}
                role="tab"
                type="button"
              >
                Log in
              </button>
              <button
                aria-selected={isSignUp}
                className={isSignUp ? 'active' : ''}
                onClick={() => setMode('sign_up')}
                role="tab"
                type="button"
              >
                Sign up
              </button>
            </div>

            <button
              className="auth-google-button"
              disabled={!configured || busy || googleBusy}
              onClick={() => void onGoogleSignIn()}
              type="button"
            >
              <GoogleMark />
              <span>{googleBusy ? 'Connecting to Google…' : 'Continue with Google'}</span>
            </button>

            <div className="auth-divider"><span /> <span>or continue with email</span> <span /></div>

            <form className="auth-page-form" onSubmit={(event) => void handleSubmit(event)}>
              <label className="auth-input-label" htmlFor="auth-email">Email address</label>
              <div className="auth-input-wrap">
                <Mail size={17} aria-hidden="true" />
                <input
                  autoComplete="email"
                  id="auth-email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  required
                  type="email"
                  value={email}
                />
              </div>

              <div className="auth-password-label-row">
                <label className="auth-input-label" htmlFor="auth-password">Password</label>
                {isSignUp && <span>At least 8 characters</span>}
              </div>
              <div className="auth-input-wrap">
                <LockKeyhole size={17} aria-hidden="true" />
                <input
                  autoComplete={isSignUp ? 'new-password' : 'current-password'}
                  id="auth-password"
                  minLength={isSignUp ? 8 : undefined}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={isSignUp ? 'Create a password' : 'Enter your password'}
                  required
                  type="password"
                  value={password}
                />
              </div>

              {!configured && (
                <div className="auth-config-notice" role="status">
                  The public R5 benchmark remains available without an account. Add Supabase settings to enable account sign-in and protected store records.
                </div>
              )}
              {error && <div className="auth-message auth-message-error" role="alert">{error}</div>}
              {notice && <div className="auth-message auth-message-success" role="status">{notice}</div>}

              <button className="auth-primary-button" disabled={!configured || busy || googleBusy} type="submit">
                <span>{busy ? 'Please wait…' : isSignUp ? 'Create account with email' : 'Log in with email'}</span>
                {!busy && <ArrowRight size={17} />}
              </button>
            </form>

            <div className="auth-trust-note">
              <ShieldCheck size={16} />
              <span>Secure sign-in by Supabase. Store access is granted separately by your administrator.</span>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
