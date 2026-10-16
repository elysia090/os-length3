// Critically damped springs drive every motion in the shell: a value chases its
// target without overshoot timing being authored per animation, and a new
// target mid-flight bends the path instead of restarting it.

export interface Spring {
  value: number;
  velocity: number;
  target: number;
}

export function spring(value: number): Spring {
  return {value, velocity: 0, target: value};
}

/**
 * Advance by dt seconds. `halfLife` is the time to close half the distance;
 * the closed form keeps the step stable for any frame time, including the
 * long first frame after a tab or window regains focus.
 */
export function step(s: Spring, dt: number, halfLife: number): Spring {
  const omega = Math.LN2 * 2 / Math.max(halfLife, 1e-4);
  const x = s.value - s.target;
  const j = s.velocity + omega * x;
  const decay = Math.exp(-omega * dt);
  s.value = s.target + (x + j * dt) * decay;
  s.velocity = (s.velocity - j * omega * dt) * decay;
  return s;
}

export function settled(s: Spring, epsilon = 1e-3): boolean {
  return Math.abs(s.value - s.target) < epsilon && Math.abs(s.velocity) < epsilon;
}
