import { createClient } from "@supabase/supabase-js";

export const RETURN_URL_KEY = "daily-cs-v2:return-url";
const REFRESH_INTERVAL_MS = 9 * 60 * 1000;

export function requireProductionConfig(config) {
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) {
    throw new Error("Supabase public configuration is missing");
  }
}

export function safeReturnUrl(value, locationLike = globalThis.location, basePath = "/Daily_CS/") {
  const fallback = new URL(basePath, locationLike.origin).href;
  if (!value) return fallback;
  try {
    const url = new URL(value, locationLike.origin);
    return url.origin === locationLike.origin && url.pathname.startsWith(basePath) ? url.href : fallback;
  } catch {
    return fallback;
  }
}

export function createAuthClient(config, storage = globalThis.sessionStorage) {
  requireProductionConfig(config);
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      flowType: "pkce",
      storage,
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true
    }
  });
}

export function createCallbackClient(config, storage = globalThis.sessionStorage) {
  requireProductionConfig(config);
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      flowType: "pkce",
      storage,
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true
    }
  });
}

export async function getVerifiedSession(client) {
  const sessionResult = await client.auth.getSession();
  if (sessionResult.error) throw sessionResult.error;
  const session = sessionResult.data.session;
  if (!session?.access_token) return null;
  const userResult = await client.auth.getUser();
  if (userResult.error) throw userResult.error;
  return { ...session, user: userResult.data.user ?? session.user };
}

export async function signInWithGoogle(client, redirectTo) {
  return client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo,
      queryParams: { prompt: "select_account" }
    }
  });
}

export async function signOut(client, scope) {
  const result = await client.auth.signOut({ scope });
  if (result.error) throw result.error;
}

export function startSessionRefresh(client, onRefresh, win = globalThis.window) {
  let timer = 0;
  const refresh = async () => {
    if (win.document?.visibilityState === "hidden") return;
    const result = await client.auth.refreshSession();
    if (result.error) {
      await onRefresh(null, result.error);
      return;
    }
    await onRefresh(result.data.session, null);
  };
  timer = win.setInterval(refresh, REFRESH_INTERVAL_MS);
  win.addEventListener?.("focus", refresh);
  win.document?.addEventListener?.("visibilitychange", refresh);
  return () => {
    win.clearInterval(timer);
    win.removeEventListener?.("focus", refresh);
    win.document?.removeEventListener?.("visibilitychange", refresh);
  };
}

