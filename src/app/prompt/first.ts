// The hot programs a first Prompt waits for: its shell (bash), and BusyBox, whose applets it runs first. The others
// translated in the release (l3, git) come after it is up. Said here alone, for the page (userland.ts) and for what
// tests it (tests/fixtures.ts) to read the same.
export const FIRST = ['/usr/bin/bash', '/usr/bin/busybox'];
