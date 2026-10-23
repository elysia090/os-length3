// Passkeys, the web's way in (remote.ts): the browser makes and gives them. The desktop app signs in through
// the browser instead (remote.ts, app), so its build takes passkeys.desktop.ts in this one's place (vite.config.ts).

export const webauthn = () => import('@simplewebauthn/browser');
