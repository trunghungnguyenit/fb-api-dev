// How the session cookies are written. Supabase's own default leaves them readable by scripts (httpOnly false) because its
// browser client needs that; this app has no browser client (every call goes through the server), so nothing in a page ever needs to
// read them, and a script that gets injected somehow must not be able to carry the session away.

type CookieOptions = { httpOnly?: boolean; secure?: boolean; sameSite?: boolean | "lax" | "strict" | "none"; path?: string; maxAge?: number; expires?: Date; domain?: string };

/** `appUrl`: where the app is served; Secure cookies are only sent over https, so they are asked for only when it is one. */
export function hardenCookie<T extends CookieOptions>(options: T | undefined, appUrl: string | undefined): T & { httpOnly: true; secure: boolean; sameSite: "lax" | "strict" | "none" } {
  const sameSite = options?.sameSite === "strict" || options?.sameSite === "none" ? options.sameSite : "lax";
  return { ...(options ?? {}), httpOnly: true, secure: (appUrl ?? "").startsWith("https://"), sameSite } as T & { httpOnly: true; secure: boolean; sameSite: "lax" | "strict" | "none" };
}
