import {BLUR_FS, COMPOSITE_FS, CUBE_FS, CUBE_VS, FLOOR_FS, FLOOR_VS, QUAD_VS} from './shaders.ts';
import type {Mat4, Vec3} from './math.ts';

/** One solid in the frame. Volume, not area, carries magnitude. */
export interface Solid {
  position: Vec3;
  size: number;
  color: Vec3;
  /** 0 = edges only, 1 = opaque body. */
  fill: number;
  glow: number;
  edge: number;
  /** Dash frequency; 0 for solid edges. Dashes mean "not connected". */
  dash: number;
  /** 0..1 assembled height. */
  reveal: number;
}

export interface Frame {
  viewProj: Mat4;
  eye: Vec3;
  pool: [number, number, number];
  solids: readonly Solid[];
  time: number;
  grain: number;
}

const FLOATS_PER_SOLID = 12;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
  return program;
}

function cubeGeometry(): Float32Array {
  // 6 faces x 2 triangles; position then normal per vertex.
  const faces: [Vec3, Vec3, Vec3][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const out: number[] = [];
  for (const [n, u, v] of faces) {
    const corner = (a: number, b: number) => [0, 1, 2].map((i) => n[i] * 0.5 + u[i] * a + v[i] * b);
    for (const [a, b] of [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, -.5], [.5, .5], [-.5, .5]]) out.push(...corner(a, b), ...n);
  }
  return new Float32Array(out);
}

interface Target { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number }

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private cube: WebGLProgram; private floor: WebGLProgram; private blur: WebGLProgram; private composite: WebGLProgram;
  private cubeVao: WebGLVertexArrayObject; private quadVao: WebGLVertexArrayObject;
  private instances: WebGLBuffer;
  private instanceData = new Float32Array(FLOATS_PER_SOLID * 64);
  private msaa: {framebuffer: WebGLFramebuffer; color: WebGLRenderbuffer; depth: WebGLRenderbuffer} | null = null;
  private scene: Target | null = null; private bloomA: Target | null = null; private bloomB: Target | null = null;
  private width = 0; private height = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {antialias: false, alpha: false, powerPreference: 'low-power'});
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.cube = compile(gl, CUBE_VS, CUBE_FS);
    this.floor = compile(gl, FLOOR_VS, FLOOR_FS);
    this.blur = compile(gl, QUAD_VS, BLUR_FS);
    this.composite = compile(gl, QUAD_VS, COMPOSITE_FS);

    this.cubeVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.cubeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, cubeGeometry(), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.instances = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(2 + i);
      gl.vertexAttribPointer(2 + i, 4, gl.FLOAT, false, FLOATS_PER_SOLID * 4, i * 16);
      gl.vertexAttribDivisor(2 + i, 1);
    }

    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
  }

  private target(width: number, height: number, previous: Target | null): Target {
    const gl = this.gl;
    if (previous) { gl.deleteTexture(previous.texture); gl.deleteFramebuffer(previous.framebuffer); }
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return {framebuffer, texture, width, height};
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    const gl = this.gl;
    this.width = width; this.height = height;
    gl.canvas.width = width; gl.canvas.height = height;
    if (this.msaa) {
      gl.deleteRenderbuffer(this.msaa.color); gl.deleteRenderbuffer(this.msaa.depth); gl.deleteFramebuffer(this.msaa.framebuffer);
    }
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    const framebuffer = gl.createFramebuffer()!, color = gl.createRenderbuffer()!, depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    this.msaa = {framebuffer, color, depth};
    this.scene = this.target(width, height, this.scene);
    const bw = Math.max(1, width >> 2), bh = Math.max(1, height >> 2);
    this.bloomA = this.target(bw, bh, this.bloomA);
    this.bloomB = this.target(bw, bh, this.bloomB);
  }

  private uploadSolids(solids: readonly Solid[]) {
    const gl = this.gl;
    if (this.instanceData.length < solids.length * FLOATS_PER_SOLID) {
      this.instanceData = new Float32Array(solids.length * FLOATS_PER_SOLID * 2);
    }
    const d = this.instanceData;
    solids.forEach((s, i) => {
      d.set([...s.position, s.size, ...s.color, s.fill, s.glow, s.edge, s.dash, s.reveal], i * FLOATS_PER_SOLID);
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, solids.length * FLOATS_PER_SOLID), gl.DYNAMIC_DRAW);
  }

  draw(frame: Frame) {
    const gl = this.gl, msaa = this.msaa!, scene = this.scene!, a = this.bloomA!, b = this.bloomB!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaa.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0.006, 0.0075, 0.0105, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    gl.useProgram(this.floor);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.floor, 'uViewProj'), false, frame.viewProj);
    gl.uniform3fv(gl.getUniformLocation(this.floor, 'uEye'), frame.eye);
    gl.uniform3fv(gl.getUniformLocation(this.floor, 'uPool'), frame.pool);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Opaque bodies write depth; open frames blend over them without it.
    const opaque = frame.solids.filter((s) => s.fill >= 0.99);
    const open = frame.solids.filter((s) => s.fill < 0.99);
    gl.useProgram(this.cube);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.cube, 'uViewProj'), false, frame.viewProj);
    gl.uniform3fv(gl.getUniformLocation(this.cube, 'uEye'), frame.eye);
    gl.uniform1f(gl.getUniformLocation(this.cube, 'uTime'), frame.time);
    gl.bindVertexArray(this.cubeVao);
    if (opaque.length) { this.uploadSolids(opaque); gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, opaque.length); }
    if (open.length) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      this.uploadSolids(open); gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, open.length);
      gl.disable(gl.BLEND); gl.depthMask(true);
    }
    gl.disable(gl.DEPTH_TEST);

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, scene.framebuffer);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);

    gl.bindVertexArray(this.quadVao);
    gl.useProgram(this.blur);
    const pass = (source: WebGLTexture, into: Target, dx: number, dy: number, threshold: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
      gl.viewport(0, 0, into.width, into.height);
      gl.bindTexture(gl.TEXTURE_2D, source);
      gl.uniform2f(gl.getUniformLocation(this.blur, 'uStep'), dx / into.width, dy / into.height);
      gl.uniform1f(gl.getUniformLocation(this.blur, 'uThreshold'), threshold);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    pass(scene.texture, a, 1, 0, 0.55);
    pass(a.texture, b, 0, 1, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.composite);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, scene.texture);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b.texture);
    gl.uniform1i(gl.getUniformLocation(this.composite, 'uScene'), 0);
    gl.uniform1i(gl.getUniformLocation(this.composite, 'uBloom'), 1);
    gl.uniform1f(gl.getUniformLocation(this.composite, 'uTime'), frame.time % 100);
    gl.uniform1f(gl.getUniformLocation(this.composite, 'uGrain'), frame.grain);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.activeTexture(gl.TEXTURE0);
  }
}
