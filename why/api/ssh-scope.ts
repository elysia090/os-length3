/** Who may connect to a device's SSH listener. */
export const SCOPES = ['device', 'network'] as const;
export type Scope = typeof SCOPES[number];
