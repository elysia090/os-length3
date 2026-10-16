// GLSL ES 3.00. One light rig is shared by floor and solids so the frame
// reads as a single lit stage: warm key from upper left, cool fill, amber rim.

const LIGHT = /* glsl */`
const vec3 KEY_DIR = normalize(vec3(-0.55, 0.8, 0.35));
const vec3 KEY = vec3(1.0, 0.86, 0.68);
const vec3 FILL = vec3(0.32, 0.42, 0.58);
const vec3 AMBER = vec3(0.94, 0.65, 0.15);
const vec3 FOG = vec3(0.006, 0.0075, 0.0105);
float fogAmount(float d) { return 1.0 - exp(-d * d * 0.0012); }
`;

export const CUBE_VS = /* glsl */`#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 iPlace;   // xyz, edge length
layout(location=3) in vec4 iColor;   // rgb, fill opacity
layout(location=4) in vec4 iStyle;   // glow, edge weight, dash, reveal
uniform mat4 uViewProj;
uniform float uTime;
out vec3 vLocal; out vec3 vNormal; out vec3 vWorld;
out vec4 vColor; out vec4 vStyle;
void main() {
  // Reveal scales from the floor up so assembly reads as building, not fading.
  float reveal = clamp(iStyle.w, 0.0, 1.0);
  vec3 local = aPos;
  vec3 p = vec3(local.x, (local.y + 0.5) * reveal - 0.5, local.z) * iPlace.w;
  vWorld = iPlace.xyz + p;
  vLocal = local; vNormal = aNormal; vColor = iColor; vStyle = iStyle;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

export const CUBE_FS = /* glsl */`#version 300 es
precision highp float;
${LIGHT}
in vec3 vLocal; in vec3 vNormal; in vec3 vWorld;
in vec4 vColor; in vec4 vStyle;
uniform vec3 uEye;
uniform float uTime;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  // Distance to the nearest edge of this face, in face units.
  vec3 a = abs(vLocal);
  vec2 f = n.x != 0.0 ? a.yz : n.y != 0.0 ? a.xz : a.xy;
  float d = 0.5 - max(f.x, f.y);
  float w = fwidth(d) * 1.5 + vStyle.y * 0.02;
  float edge = 1.0 - smoothstep(0.0, w, d);
  // Dashed edges mark structure that is not connected yet.
  if (vStyle.z > 0.0) {
    vec2 g = n.x != 0.0 ? vLocal.yz : n.y != 0.0 ? vLocal.xz : vLocal.xy;
    float along = abs(f.x) > abs(f.y) ? g.y : g.x;
    edge *= step(0.5, fract(along * vStyle.z * 4.0));
  }
  vec3 v = normalize(uEye - vWorld);
  float diff = max(dot(n, KEY_DIR), 0.0);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 lit = vColor.rgb * (KEY * diff * 0.9 + FILL * (0.12 + 0.1 * n.y)) + AMBER * rim * 0.12;
  vec3 edgeColor = mix(vec3(0.85, 0.82, 0.76), AMBER, 0.5) * (0.7 + vStyle.x);
  vec3 color = mix(lit, edgeColor, edge * vStyle.y) + vColor.rgb * vStyle.x * 0.8;
  float alpha = max(vColor.a, edge * vStyle.y);
  if (alpha < 0.01) discard;
  color = mix(color, FOG, fogAmount(length(uEye - vWorld)));
  outColor = vec4(color, alpha);
}`;

export const FLOOR_VS = /* glsl */`#version 300 es
layout(location=0) in vec2 aPos;
uniform mat4 uViewProj;
out vec3 vWorld;
void main() {
  vWorld = vec3(aPos.x * 200.0, 0.0, aPos.y * 200.0);
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

export const FLOOR_FS = /* glsl */`#version 300 es
precision highp float;
${LIGHT}
in vec3 vWorld;
uniform vec3 uEye;
uniform vec3 uPool;     // xz of the light pool, radius
out vec4 outColor;
float grid(vec2 p, float size) {
  vec2 g = abs(fract(p / size - 0.5) - 0.5) / fwidth(p / size);
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  vec2 p = vWorld.xz;
  float minor = grid(p, 1.0) * 0.05, major = grid(p, 8.0) * 0.12;
  float pool = exp(-dot(p - uPool.xy, p - uPool.xy) / (uPool.z * uPool.z));
  vec3 base = FOG + KEY * pool * 0.035;
  vec3 color = base + mix(vec3(0.3, 0.33, 0.38), AMBER, 0.45) * max(minor, major) * (0.25 + pool * 1.6);
  color = mix(color, FOG, fogAmount(length(uEye - vWorld)));
  outColor = vec4(color, 1.0);
}`;

export const QUAD_VS = /* glsl */`#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** Bright-pass downsample, then a separable blur reusing the same program. */
export const BLUR_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uStep;
uniform float uThreshold;
out vec4 outColor;
void main() {
  vec3 sum = vec3(0.0);
  float weights[5] = float[](0.227, 0.194, 0.121, 0.054, 0.016);
  for (int i = -4; i <= 4; i++) {
    vec3 c = texture(uSource, vUv + uStep * float(i)).rgb;
    sum += max(c - uThreshold, 0.0) * weights[abs(i)];
  }
  outColor = vec4(sum, 1.0);
}`;

export const COMPOSITE_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uTime;
uniform float uGrain;
out vec4 outColor;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 c = vUv - 0.5;
  float r2 = dot(c, c);
  // Lens: slight chromatic fringe toward the frame edge.
  vec2 shift = c * r2 * 0.012;
  vec3 col = vec3(texture(uScene, vUv + shift).r, texture(uScene, vUv).g, texture(uScene, vUv - shift).b);
  col += texture(uBloom, vUv).rgb * 0.9;
  col = aces(col * 1.15);
  col *= mix(1.0, 0.55, smoothstep(0.12, 0.62, r2));
  col += (hash(vUv * 1024.0 + uTime) - 0.5) * uGrain;
  outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;
