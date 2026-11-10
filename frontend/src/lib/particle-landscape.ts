type Field = { x: number; y: number; width: number; height: number };

export type LandscapeRenderer = {
  fps: number;
  resize: (width: number, height: number, pixelRatio: number) => void;
  draw: (time: number) => void;
  dispose: () => void;
};

function fieldFor(width: number, height: number): Field {
  const mobile = width <= 700;
  const fieldHeight = Math.min(height * .66, mobile ? 390 : width >= 1600 ? 580 : 520);
  return {
    x: mobile ? -width * .5 : 0,
    y: height - fieldHeight - Math.min(height * .1, 96),
    width: width * (mobile ? 1.5 : 1),
    height: fieldHeight,
  };
}

function pointsFor(width: number, fallback: boolean) {
  const columns = Math.min(Math.ceil(width / (fallback ? 6 : 4)), fallback ? 160 : 480);
  const rows = fallback ? 72 : 100;
  // Overscan the sides so horizontal motion never exposes a straight edge.
  const padding = Math.ceil(columns * .04);
  const points = new Float32Array((columns + padding * 2 + 1) * rows * 2);
  let index = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = -padding; column <= columns + padding; column++) {
      points[index++] = column / columns;
      points[index++] = row / rows;
    }
  }
  return points;
}

// Keep the original two ridges, blue color, depth, and tiny square particles.
// All movement happens in the vertex shader; the point buffer stays on the GPU.
const vertexSource = `
  precision highp float;
  attribute vec2 a_point;
  uniform vec2 u_viewport;
  uniform vec4 u_field;
  uniform float u_pixelRatio;
  uniform float u_time;
  varying float v_alpha;

  void main() {
    float x = a_point.x;
    float depth = a_point.y;
    float flow = sin(u_time * .2) * .025;
    float bend = sin(u_time * .16 + depth * 4.) * .017;
    float first = (x - .63 + depth * .21 - flow - bend) / .16;
    float second = (x - 1.05 + depth * .18 - flow * .7) / .29;
    float ridge = exp(-first * first) * .6 + exp(-second * second) * .92;
    float ripple = sin(x * 26. + depth * 12. - u_time * .6) * .02
      + cos(x * 49. - depth * 17. + u_time * .42) * .008;
    float swell = sin(x * 9. + depth * 6. - u_time * .26) * .018;
    float elevation = (ridge + ripple + swell) * (1. - depth * .44);
    float px = u_field.x + (x + sin(u_time * .12 + depth * 5.) * .006) * u_field.z;
    float py = u_field.y + (.86 + depth * .47 - elevation * .79) * u_field.w;
    gl_Position = vec4(px / u_viewport.x * 2. - 1., 1. - py / u_viewport.y * 2., 0., 1.);
    gl_PointSize = max(1., (.85 + depth * .8) * u_pixelRatio);
    float tone = clamp(x, 0., 1.);
    v_alpha = (.12 + tone * .52 + depth * .27) * min(tone * 3.5, 1.);
  }
`;

const fragmentSource = `
  precision mediump float;
  varying float v_alpha;
  void main() {
    vec2 edge = abs(gl_PointCoord - .5);
    float alpha = v_alpha * (1. - smoothstep(.3, .5, max(edge.x, edge.y)));
    gl_FragColor = vec4(vec3(48., 108., 229.) / 255. * alpha, alpha);
  }
`;

export function createWebGLLandscape(canvas: HTMLCanvasElement): LandscapeRenderer | null {
  const gl = canvas.getContext('webgl', {
    alpha: true, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: true, powerPreference: 'low-power',
  });
  if (!gl) return null;

  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  const dispose = () => {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    shaders.forEach(shader => gl.deleteShader(shader));
    if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
  };

  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Shader unavailable');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader compilation failed');
      return shader;
    };
    program = gl.createProgram();
    buffer = gl.createBuffer();
    if (!program || !buffer) throw new Error('Renderer unavailable');
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader linking failed');
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const point = gl.getAttribLocation(program, 'a_point');
    gl.enableVertexAttribArray(point);
    gl.vertexAttribPointer(point, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    const viewport = gl.getUniformLocation(program, 'u_viewport');
    const field = gl.getUniformLocation(program, 'u_field');
    const ratio = gl.getUniformLocation(program, 'u_pixelRatio');
    const time = gl.getUniformLocation(program, 'u_time');
    let count = 0;

    return {
      fps: 60,
      resize(width, height, pixelRatio) {
        const geometry = fieldFor(width, height);
        const points = pointsFor(geometry.width, false);
        count = points.length / 2;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);
        gl.uniform2f(viewport, width, height);
        gl.uniform4f(field, geometry.x, geometry.y, geometry.width, geometry.height);
        gl.uniform1f(ratio, pixelRatio);
      },
      draw(seconds) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(time, seconds);
        gl.drawArrays(gl.POINTS, 0, count);
      },
      dispose,
    };
  } catch {
    dispose();
    return null;
  }
}

/** Fewer points, batched opacity, and 30fps for devices without WebGL. */
export function createCanvasLandscape(canvas: HTMLCanvasElement): LandscapeRenderer | null {
  const context = canvas.getContext('2d');
  if (!context) return null;
  type Point = { x: number; depth: number; size: number };
  const groups: Point[][] = Array.from({ length: 12 }, () => []);
  const colors = groups.map((_, index) => `rgba(48,108,229,${(index + .5) / groups.length})`);
  let field: Field;
  let width = 0;
  let height = 0;

  return {
    fps: 30,
    resize(nextWidth, nextHeight, pixelRatio) {
      width = nextWidth;
      height = nextHeight;
      field = fieldFor(width, height);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      groups.forEach(group => { group.length = 0; });
      const points = pointsFor(field.width, true);
      for (let index = 0; index < points.length; index += 2) {
        const x = points[index];
        const depth = points[index + 1];
        const tone = Math.max(0, Math.min(x, 1));
        const alpha = (.12 + tone * .52 + depth * .27) * Math.min(tone * 3.5, 1);
        if (alpha <= 0) continue;
        groups[Math.min(groups.length - 1, Math.floor(alpha * groups.length))].push({ x, depth, size: .85 + depth * .8 });
      }
    },
    draw(time) {
      context.clearRect(0, 0, width, height);
      const flow = Math.sin(time * .2) * .025;
      for (let group = 0; group < groups.length; group++) {
        context.fillStyle = colors[group];
        for (const { x, depth, size } of groups[group]) {
          // Same surface and motion as the vertex shader above.
          const bend = Math.sin(time * .16 + depth * 4) * .017;
          const first = (x - .63 + depth * .21 - flow - bend) / .16;
          const second = (x - 1.05 + depth * .18 - flow * .7) / .29;
          const ridge = Math.exp(-first * first) * .6 + Math.exp(-second * second) * .92;
          const ripple = Math.sin(x * 26 + depth * 12 - time * .6) * .02
            + Math.cos(x * 49 - depth * 17 + time * .42) * .008;
          const swell = Math.sin(x * 9 + depth * 6 - time * .26) * .018;
          const elevation = (ridge + ripple + swell) * (1 - depth * .44);
          const px = field.x + (x + Math.sin(time * .12 + depth * 5) * .006) * field.width;
          const py = field.y + (.86 + depth * .47 - elevation * .79) * field.height;
          if (px < -size || px > width || py < -size || py > height) continue;
          context.fillRect(px - size / 2, py - size / 2, size, size);
        }
      }
    },
    dispose() { groups.forEach(group => { group.length = 0; }); },
  };
}
