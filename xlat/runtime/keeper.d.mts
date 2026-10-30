// Types for keeper.mjs, as the page reads them (os/src/userland.ts).
export const MAIN: number;
export const MORE: number;
export interface Kept { cache: string; at: Record<string, {main: string; more: string | null}> }
export function keeper(kept: Kept, ready: () => void, read?: (urls: string[]) => void): {has(origin: string): boolean; reading(): number; take(origin: string): unknown};
export function unpackMore(body: Uint8Array): {base: number; bytes: Uint8Array}[];
