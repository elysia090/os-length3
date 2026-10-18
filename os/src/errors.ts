/** What went wrong, as a person reads it: an Error's sentence (never "Error: …"), or what was thrown, as text. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
