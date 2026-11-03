//! A small WebGL2 line renderer: one buffer, one program, one draw per trace.
//!
//! The plot band used to be a 2D canvas: fine for one trace of a few hundred points,
//! but every sample was a `lineTo` on the CPU. A GPU buffer costs one upload per frame
//! and draws a line strip of any length without touching the CPU again.

export interface GLTrace {
  /** x and y pairs in clip space, already normalised by the caller. */
  points: number[]
  colour: [number, number, number]
}

const VERTEX = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision mediump float;
uniform vec3 colour;
out vec4 outColour;
void main() {
  outColour = vec4(colour, 1.0);
}`

/** A renderer that draws normalised traces, or nothing when WebGL2 is absent. */
export class TraceRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private buffer: WebGLBuffer
  private position: number
  private colour: WebGLUniformLocation | null

  private constructor(gl: WebGL2RenderingContext, program: WebGLProgram) {
    this.gl = gl
    this.program = program
    this.buffer = gl.createBuffer() as WebGLBuffer
    this.position = gl.getAttribLocation(program, 'position')
    this.colour = gl.getUniformLocation(program, 'colour')
  }

  /** Build a renderer, or null when this machine has no WebGL2. */
  static create(canvas: HTMLCanvasElement): TraceRenderer | null {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false })
    if (!gl) return null
    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind) as WebGLShader
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        return null
      }
      return shader
    }
    const vertex = compile(gl.VERTEX_SHADER, VERTEX)
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT)
    if (!vertex || !fragment) return null
    const program = gl.createProgram() as WebGLProgram
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
    return new TraceRenderer(gl, program)
  }

  /** Resize the drawing buffer to the element's size at device pixel ratio. */
  resize(width: number, height: number, ratio: number): void {
    const w = Math.max(1, Math.round(width * ratio))
    const h = Math.max(1, Math.round(height * ratio))
    if (this.gl.canvas.width !== w || this.gl.canvas.height !== h) {
      this.gl.canvas.width = w
      this.gl.canvas.height = h
    }
    this.gl.viewport(0, 0, w, h)
  }

  /**
   * Draw traces in clip space.
   *
   * `traces` arrive already scaled to -1..1 by the caller, which keeps the autoscale
   * policy in one place instead of splitting it between TypeScript and GLSL.
   */
  draw(traces: GLTrace[]): void {
    const gl = this.gl
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.enableVertexAttribArray(this.position)
    gl.vertexAttribPointer(this.position, 2, gl.FLOAT, false, 0, 0)

    for (const trace of traces) {
      const count = trace.points.length / 2
      if (count < 2) continue
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(trace.points), gl.DYNAMIC_DRAW)
      gl.uniform3f(this.colour, trace.colour[0], trace.colour[1], trace.colour[2])
      gl.drawArrays(gl.LINE_STRIP, 0, count)
    }
  }
}

/** The six trace colours as 0..1 triples, matching the palette in the stylesheet. */
export const SERIES_RGB: [number, number, number][] = [
  [16 / 255, 185 / 255, 129 / 255],
  [6 / 255, 182 / 255, 212 / 255],
  [245 / 255, 158 / 255, 11 / 255],
  [239 / 255, 68 / 255, 68 / 255],
  [167 / 255, 139 / 255, 250 / 255],
  [56 / 255, 189 / 255, 248 / 255],
]
