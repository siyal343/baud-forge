// Zero-leak singleton offscreen WebGL2 waveform renderer.
// Normalizes coordinates in JS Float64 relative to [xMin, xMax] / [yMin, yMax]
// before packing into a reusable Float32Array VBO so 24-bit Float32 mantissa
// precision stays sub-pixel sharp even at µs epoch timestamps (~1.7e15).

export interface WebGLTrace {
  t: Float64Array | Float32Array;
  v: Float64Array | Float32Array;
  count: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  color: string;
  lineWidth?: number;
  alpha?: number;
}

export interface WebGLRenderRect {
  x: number; // CSS px inside canvas
  y: number;
  w: number;
  h: number;
  dpr: number;
  phosphor?: boolean;
}

const VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform vec2 u_offset;
void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0 + u_offset, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = u_color;
}
`;

interface GlSingleton {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  uColor: WebGLUniformLocation | null;
  uOffset: WebGLUniformLocation | null;
  maxLineWidth: number;
  maxViewportW: number;
  maxViewportH: number;
  vboByteCapacity: number;
  contextLost: boolean;
}

let singleton: GlSingleton | null = null;
let permanentlyUnavailable = false;
let staging = new Float32Array(4096);
const segStarts: number[] = [];
const segCounts: number[] = [];
const COLOR_CACHE = new Map<string, [number, number, number, number]>();

function parseCssColor(color: string): [number, number, number, number] {
  const cached = COLOR_CACHE.get(color);
  if (cached) return cached;

  let rgba: [number, number, number, number] = [1, 1, 1, 1];
  const s = color.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        rgba = [r / 255, g / 255, b / 255, 1];
      }
    } else if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
        rgba = [r / 255, g / 255, b / 255, a];
      }
    }
  } else {
    const m = /^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i.exec(s);
    if (m) {
      const r = Math.min(255, Math.max(0, parseFloat(m[1]))) / 255;
      const g = Math.min(255, Math.max(0, parseFloat(m[2]))) / 255;
      const b = Math.min(255, Math.max(0, parseFloat(m[3]))) / 255;
      let a = 1;
      if (m[4] !== undefined) {
        a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        a = Math.min(1, Math.max(0, Number.isFinite(a) ? a : 1));
      }
      rgba = [r, g, b, a];
    }
  }

  if (COLOR_CACHE.size < 256) COLOR_CACHE.set(color, rgba);
  return rgba;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function initResources(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext): GlSingleton | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  if (!vao || !vbo) {
    if (vao) gl.deleteVertexArray(vao);
    if (vbo) gl.deleteBuffer(vbo);
    gl.deleteProgram(program);
    return null;
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const lineRange = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE) as Float32Array | number[] | null;
  const maxLineWidth = lineRange && lineRange.length >= 2 ? Number(lineRange[1]) || 1 : 1;
  const vpDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | number[] | null;
  const maxViewportW = vpDims && vpDims.length >= 2 ? Number(vpDims[0]) || 4096 : 4096;
  const maxViewportH = vpDims && vpDims.length >= 2 ? Number(vpDims[1]) || 4096 : 4096;

  return {
    canvas,
    gl,
    program,
    vao,
    vbo,
    uColor: gl.getUniformLocation(program, 'u_color'),
    uOffset: gl.getUniformLocation(program, 'u_offset'),
    maxLineWidth,
    maxViewportW,
    maxViewportH,
    vboByteCapacity: 0,
    contextLost: false,
  };
}

function getSingleton(): GlSingleton | null {
  if (permanentlyUnavailable) return null;
  if (singleton) return singleton.contextLost ? null : singleton;
  if (typeof document === 'undefined') return null;

  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
    });
    if (!gl) {
      permanentlyUnavailable = true;
      return null;
    }

    const res = initResources(canvas, gl);
    if (!res) {
      permanentlyUnavailable = true;
      return null;
    }

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (singleton) singleton.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      const rebuilt = initResources(canvas, gl);
      if (rebuilt) {
        singleton = rebuilt;
      } else {
        permanentlyUnavailable = true;
        singleton = null;
      }
    });

    singleton = res;
    return singleton;
  } catch {
    permanentlyUnavailable = true;
    return null;
  }
}

function ensureStagingCapacity(neededFloats: number): void {
  if (staging.length >= neededFloats) return;
  let cap = staging.length;
  while (cap < neededFloats) cap *= 2;
  staging = new Float32Array(cap);
}

/**
 * Render all provided waveform traces into a singleton offscreen WebGL2 canvas
 * and blit onto `targetCtx`. Returns false when WebGL2 is unavailable or inputs
 * are invalid so callers can transparently fall back to Canvas 2D.
 */
export function renderWaveformsWebGL(
  targetCtx: CanvasRenderingContext2D,
  rect: WebGLRenderRect,
  traces: WebGLTrace[]
): boolean {
  if (!Number.isFinite(rect.w) || !Number.isFinite(rect.h) || rect.w <= 0 || rect.h <= 0) {
    return false;
  }
  const dpr = Number.isFinite(rect.dpr) && rect.dpr > 0 ? rect.dpr : 1;

  const s = getSingleton();
  if (!s) return false;

  const { gl, canvas } = s;
  const wPx = Math.min(s.maxViewportW, Math.max(1, Math.round(rect.w * dpr)));
  const hPx = Math.min(s.maxViewportH, Math.max(1, Math.round(rect.h * dpr)));

  if (canvas.width !== wPx || canvas.height !== hPx) {
    canvas.width = wPx;
    canvas.height = hPx;
  }

  gl.viewport(0, 0, wPx, hPx);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  if (traces.length === 0) return true;

  gl.useProgram(s.program);
  gl.bindVertexArray(s.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, s.vbo);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const dx = 1.5 / wPx;
  const dy = 1.5 / hPx;

  for (let ti = 0; ti < traces.length; ti++) {
    const tr = traces[ti];
    const count = Math.min(tr.count, tr.t.length, tr.v.length);
    if (count < 2) continue;
    const xSpan = tr.xMax - tr.xMin;
    const ySpan = tr.yMax - tr.yMin;
    if (!Number.isFinite(xSpan) || !Number.isFinite(ySpan) || xSpan <= 0 || ySpan <= 0) continue;

    const invX = 1 / xSpan;
    const invY = 1 / ySpan;
    const xMin = tr.xMin;
    const yMin = tr.yMin;

    ensureStagingCapacity(count * 2);
    segStarts.length = 0;
    segCounts.length = 0;

    let writeVert = 0;
    let runStart = 0;
    let runLen = 0;
    for (let i = 0; i < count; i++) {
      const tv = tr.t[i];
      const vv = tr.v[i];
      if (!Number.isFinite(tv) || !Number.isFinite(vv)) {
        if (runLen >= 2) {
          segStarts.push(runStart);
          segCounts.push(runLen);
        }
        runStart = writeVert;
        runLen = 0;
        continue;
      }
      const fIdx = writeVert * 2;
      staging[fIdx] = (tv - xMin) * invX;
      staging[fIdx + 1] = (vv - yMin) * invY;
      writeVert++;
      runLen++;
    }
    if (runLen >= 2) {
      segStarts.push(runStart);
      segCounts.push(runLen);
    }
    if (segCounts.length === 0) continue;

    const writtenFloats = writeVert * 2;
    const neededBytes = writtenFloats * 4;
    if (neededBytes > s.vboByteCapacity) {
      s.vboByteCapacity = staging.byteLength;
      gl.bufferData(gl.ARRAY_BUFFER, s.vboByteCapacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, staging.subarray(0, writtenFloats));

    const [r, g, b, baseA] = parseCssColor(tr.color);
    const alpha = baseA * (tr.alpha ?? 1);
    const reqWidth = Math.max(1, (tr.lineWidth ?? 1) * dpr);
    gl.lineWidth(Math.min(s.maxLineWidth, reqWidth));

    if (rect.phosphor) {
      gl.uniform4f(s.uColor, r, g, b, alpha * 0.25);
      const offsets: readonly [number, number][] = [
        [-dx, 0],
        [dx, 0],
        [0, -dy],
        [0, dy],
      ];
      for (let oi = 0; oi < 4; oi++) {
        gl.uniform2f(s.uOffset, offsets[oi][0], offsets[oi][1]);
        for (let si = 0; si < segCounts.length; si++) {
          gl.drawArrays(gl.LINE_STRIP, segStarts[si], segCounts[si]);
        }
      }
    }

    gl.uniform2f(s.uOffset, 0, 0);
    gl.uniform4f(s.uColor, r, g, b, alpha);
    for (let si = 0; si < segCounts.length; si++) {
      gl.drawArrays(gl.LINE_STRIP, segStarts[si], segCounts[si]);
    }
  }

  gl.bindVertexArray(null);

  try {
    targetCtx.drawImage(canvas, 0, 0, wPx, hPx, rect.x, rect.y, rect.w, rect.h);
    return true;
  } catch {
    return false;
  }
}
