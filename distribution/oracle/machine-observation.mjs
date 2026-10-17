// Oracle input construction only; no guest execution or fault handling.
export function seedDisabledDebug(view, base) {
  // The fixed CPU profile has no RTM. DR7 bit 10 is one, while every
  // breakpoint enable and GD is zero. Poison all unrelated state separately.
  view.setBigUint64(base + 600, 0x400n, true);
}
