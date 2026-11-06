export type AuthRouteDecision =
  | 'loading'
  | 'login'
  | 'dashboard'
  | 'redirect-login'
  | 'redirect-dashboard';

export function authRouteDecision(
  pathname: string,
  isCheckingSession: boolean,
  hasSupabaseSession: boolean,
): AuthRouteDecision {
  if (isCheckingSession) return 'loading';

  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  const isLoginRoute = normalizedPath === '/login';
  const protectedRoots = ['/dashboard', '/workspace', '/incidents', '/settings'];
  const requiresSession = protectedRoots.some((root) => normalizedPath === root || normalizedPath.startsWith(`${root}/`));

  // The root path is the public, read-only R5 benchmark and evaluation demo.
  // Account data and workspace routes remain behind Supabase authentication.
  if (!hasSupabaseSession) {
    if (isLoginRoute) return 'login';
    return requiresSession ? 'redirect-login' : 'dashboard';
  }
  return isLoginRoute ? 'redirect-dashboard' : 'dashboard';
}
