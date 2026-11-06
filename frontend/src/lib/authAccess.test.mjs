import assert from 'node:assert/strict';
import test from 'node:test';

import { authRouteDecision } from './authAccess.ts';
import {
  restoreSupabaseSession,
  signInWithEmailPassword,
  signInWithGoogle,
  signOutFromSupabase,
  signUpWithEmailPassword,
} from './authActions.ts';

const session = { access_token: 'test-session-token', user: { id: 'user-1', email: 'worker@example.test' } };

test('the auth loading state never renders a route before session restoration finishes', () => {
  assert.equal(authRouteDecision('/', true, false), 'loading');
  assert.equal(authRouteDecision('/dashboard', true, true), 'loading');
});

test('the public benchmark is available without an account while private routes require one', () => {
  assert.equal(authRouteDecision('/', false, false), 'dashboard');
  for (const path of ['/dashboard', '/workspace', '/incidents', '/settings']) {
    assert.equal(authRouteDecision(path, false, false), 'redirect-login');
  }
  assert.equal(authRouteDecision('/login', false, false), 'login');
  assert.equal(authRouteDecision('/login/', false, false), 'login');
});

test('a restored Supabase session opens the dashboard and redirects away from login', () => {
  assert.equal(authRouteDecision('/', false, true), 'dashboard');
  assert.equal(authRouteDecision('/dashboard', false, true), 'dashboard');
  assert.equal(authRouteDecision('/login', false, true), 'redirect-dashboard');
});

test('session restoration trusts the Supabase auth response and surfaces auth errors', async () => {
  assert.equal(await restoreSupabaseSession({ getSession: async () => ({ data: { session }, error: null }) }), session);
  await assert.rejects(
    restoreSupabaseSession({ getSession: async () => ({ data: { session: null }, error: new Error('expired') }) }),
    /expired/,
  );
});

test('email/password sign-in calls Supabase and requires a returned session', async () => {
  let credentials;
  const auth = {
    signInWithPassword: async (value) => { credentials = value; return { data: { session }, error: null }; },
  };
  assert.equal(await signInWithEmailPassword(auth, 'worker@example.test', 'password-123'), session);
  assert.deepEqual(credentials, { email: 'worker@example.test', password: 'password-123' });
  await assert.rejects(
    signInWithEmailPassword({ signInWithPassword: async () => ({ data: { session: null }, error: null }) }, 'x', 'y'),
    /active session/,
  );
});

test('sign-up recognizes both confirmation-required and immediate-session responses', async () => {
  let signUpRequest;
  const pendingAuth = {
    signUp: async (value) => { signUpRequest = value; return { data: { session: null }, error: null }; },
  };
  const pending = await signUpWithEmailPassword(pendingAuth, 'worker@example.test', 'password-123', 'http://localhost:5173/login');
  assert.equal(pending.confirmationRequired, true);
  assert.equal(pending.session, null);
  assert.equal(signUpRequest.options.emailRedirectTo, 'http://localhost:5173/login');

  const immediate = await signUpWithEmailPassword(
    { signUp: async () => ({ data: { session }, error: null }) },
    'worker@example.test',
    'password-123',
    'http://localhost:5173/login',
  );
  assert.equal(immediate.confirmationRequired, false);
  assert.equal(immediate.session, session);
});

test('Google sign-in requests Supabase OAuth with the app callback URL', async () => {
  let request;
  await signInWithGoogle({
    signInWithOAuth: async (value) => { request = value; return { data: { provider: 'google', url: 'https://accounts.google.com' }, error: null }; },
  }, 'http://localhost:5173/');
  assert.deepEqual(request, {
    provider: 'google',
    options: { redirectTo: 'http://localhost:5173/' },
  });
  await assert.rejects(
    signInWithGoogle({ signInWithOAuth: async () => ({ data: null, error: new Error('Google is not enabled') }) }, 'http://localhost:5173/'),
    /Google is not enabled/,
  );
});

test('logout calls Supabase signOut and preserves errors for the UI', async () => {
  let signedOut = false;
  await signOutFromSupabase({ signOut: async () => { signedOut = true; return { error: null }; } });
  assert.equal(signedOut, true);
  await assert.rejects(
    signOutFromSupabase({ signOut: async () => ({ error: new Error('network unavailable') }) }),
    /network unavailable/,
  );
});
