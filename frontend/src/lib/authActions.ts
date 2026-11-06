import type { Session, SupabaseClient } from '@supabase/supabase-js';

type SupabaseAuthApi = Pick<
  SupabaseClient['auth'],
  'getSession' | 'signInWithPassword' | 'signUp' | 'signOut'
>;

type SupabaseOAuthApi = Pick<SupabaseClient['auth'], 'signInWithOAuth'>;

export async function restoreSupabaseSession(auth: SupabaseAuthApi): Promise<Session | null> {
  const { data, error } = await auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function signInWithEmailPassword(
  auth: SupabaseAuthApi,
  email: string,
  password: string,
): Promise<Session> {
  const { data, error } = await auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error('Supabase did not return an active session.');
  return data.session;
}

export async function signInWithGoogle(
  auth: SupabaseOAuthApi,
  redirectTo: string,
): Promise<void> {
  const { error } = await auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  });
  if (error) throw error;
}

export async function signUpWithEmailPassword(
  auth: SupabaseAuthApi,
  email: string,
  password: string,
  emailRedirectTo: string,
): Promise<{ session: Session | null; confirmationRequired: boolean }> {
  const { data, error } = await auth.signUp({
    email,
    password,
    options: { emailRedirectTo },
  });
  if (error) throw error;
  const session = data.session ?? null;
  return { session, confirmationRequired: session === null };
}

export async function signOutFromSupabase(auth: SupabaseAuthApi): Promise<void> {
  const { error } = await auth.signOut();
  if (error) throw error;
}
