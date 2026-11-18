// The hot programs a first Prompt waits for: its shell (bash), and BusyBox, whose applets it runs first. The others
// translated in the release (git, and what a product put in it) come after it is up. Said here alone, for what loads
// the root (root.ts) and for what tests it to read the same.
export const FIRST = ['/usr/bin/bash', '/usr/bin/busybox'];
