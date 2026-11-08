// For tests: a browser's cookies for its Remote, as a browser keeps them. Its session is one of them (the page holds
// no token: src/remote/people/auth.ts), set by what the Remote answers the browser's own requests and sent with each of them.
// A test's own request, one that names its cookies or a bearer, is no browser's and goes as it says. Not part of the app.

/** The session cookie's name off HTTPS (src/remote/people/auth.ts SESSION_COOKIES), where the tests' Remotes are. */
const SESSION = 'better-auth.session_token';

export function cookieJar() {
  const jar = new Map<string, string>();
  return {
    /** `init`'s headers as the browser sends them: its cookies besides, unless the request is a test's own. */
    sent(init?: RequestInit): {headers: Headers; browser: boolean} {
      const headers = new Headers(init?.headers);
      const browser = !headers.has('Cookie') && !headers.has('Authorization');
      if (browser && jar.size) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      return {headers, browser};
    },
    /** What `r` sets, kept (or let go, when it ends one). */
    keep(r: Response) {
      for (const c of r.headers.getSetCookie()) {
        const pair = c.split(';')[0], at = pair.indexOf('=');
        if (at <= 0) continue;
        const name = pair.slice(0, at), value = pair.slice(at + 1);
        if (!value || /;\s*max-age=0\b/i.test(c)) jar.delete(name); else jar.set(name, value);
      }
    },
    /** The browser in as the session `bearer` is (its cookie's own value: src/remote/tests/testing.ts bearerOf). */
    session(bearer: string) { jar.set(SESSION, encodeURIComponent(bearer)); },
    /** Whether the browser holds a session's cookie. */
    signedIn: () => jar.has(SESSION),
  };
}
