import type { Config } from '../config';
import { RENDER_STRIDE } from '../particles/ParticleSystem';

const VERTEX_SHADER = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in float a_size;
layout(location = 2) in float a_alpha;
uniform vec2 u_resolution;
uniform float u_pixelRatio;
out float v_alpha;

void main() {
  vec2 clip = (a_position / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = max(a_size * u_pixelRatio, 1.0);
  v_alpha = a_alpha;
}`;

const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision mediump float;
uniform vec3 u_color;
in float v_alpha;
out vec4 outColor;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float disc = 1.0 - smoothstep(0.5, 1.0, d);
  float a = disc * v_alpha;
  outColor = vec4(u_color * a, a);
}`;

/**
 * Un único draw call de GL_POINTS. Para miles de puntos con mezcla aditiva no hace falta
 * un grafo de escena: Three.js o PixiJS sólo añadirían peso y capas entre el buffer y la GPU.
 */
export class Renderer {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniforms: { resolution: WebGLUniformLocation | null; pixelRatio: WebGLUniformLocation | null; color: WebGLUniformLocation | null } | null = null;
  private cssWidth = 1;
  private cssHeight = 1;
  private pixelRatio = 1;
  private contextLost = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly settings: Config['render'],
    private readonly maxParticles: number,
  ) {
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
      console.error('[render] Contexto WebGL perdido');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      console.warn('[render] Contexto WebGL restaurado');
      this.contextLost = false;
      this.init();
    });
    this.init();
  }

  get available(): boolean {
    return this.gl !== null && !this.contextLost;
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.pixelRatio = Math.min(devicePixelRatio, this.settings.maxDevicePixelRatio);
    this.canvas.width = Math.round(cssWidth * this.pixelRatio);
    this.canvas.height = Math.round(cssHeight * this.pixelRatio);
  }

  draw(data: Float32Array, count: number): void {
    const gl = this.gl;
    if (!gl || this.contextLost || !this.program || !this.uniforms) return;

    const [r, g, b] = this.settings.background;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (count === 0) return;

    gl.useProgram(this.program);
    gl.uniform2f(this.uniforms.resolution, this.cssWidth, this.cssHeight);
    gl.uniform1f(this.uniforms.pixelRatio, this.pixelRatio);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * RENDER_STRIDE);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  private init(): void {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    });
    if (!gl) {
      console.error('[render] WebGL2 no disponible');
      return;
    }
    this.gl = gl;

    const program = gl.createProgram();
    gl.attachShader(program, this.compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, this.compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`[render] Error al enlazar shaders: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    this.uniforms = {
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      pixelRatio: gl.getUniformLocation(program, 'u_pixelRatio'),
      color: gl.getUniformLocation(program, 'u_color'),
    };

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.maxParticles * RENDER_STRIDE * Float32Array.BYTES_PER_ELEMENT, gl.DYNAMIC_DRAW);
    const stride = RENDER_STRIDE * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 12);

    gl.useProgram(program);
    const [cr, cg, cb] = this.settings.particleColor;
    gl.uniform3f(this.uniforms.color, cr, cg, cb);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
  }

  private compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('[render] No se pudo crear el shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`[render] Error de shader: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  }
}
