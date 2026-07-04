// Minimal raw-WebGL renderer: additive-blended orbit lines, soft point sprites.

// ---- mat4 helpers (column-major) ----
export function mat4Perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect; out[5] = f;
  out[10] = (far + near) / (near - far); out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function mat4LookAt(out, eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz); zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1; xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

export function mat4Multiply(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

// Project world point through mvp → screen px. Returns w (<=0 means behind camera).
export function projectPoint(mvp, x, y, z, viewW, viewH, out) {
  const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
  const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
  const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
  out[0] = (cx / cw * 0.5 + 0.5) * viewW;
  out[1] = (1 - (cy / cw * 0.5 + 0.5)) * viewH;
  return cw;
}

// ---- shaders ----
const LINE_VS = `
attribute vec3 aPos;
attribute vec4 aCol;
uniform mat4 uMVP;
varying vec4 vCol;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
  vCol = aCol;
}`;

const LINE_FS = `
precision mediump float;
varying vec4 vCol;
uniform float uAlpha;
void main() {
  float a = vCol.a * uAlpha;
  gl_FragColor = vec4(vCol.rgb * a, a);
}`;

const POINT_VS = `
attribute vec3 aPos;
attribute vec4 aCol;
attribute float aSize;
uniform mat4 uMVP;
uniform float uScale;
varying vec4 vCol;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
  gl_PointSize = aSize * uScale;
  vCol = aCol;
}`;

const POINT_FS = `
precision mediump float;
varying vec4 vCol;
uniform float uAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float fall = smoothstep(1.0, 0.35, d);
  float a = vCol.a * fall * uAlpha;
  gl_FragColor = vec4(vCol.rgb * a, a);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s));
  }
  return s;
}

function makeProgram(gl, vs, fs, attribs, uniforms) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p));
  }
  const out = { program: p, a: {}, u: {} };
  for (const name of attribs) out.a[name] = gl.getAttribLocation(p, name);
  for (const name of uniforms) out.u[name] = gl.getUniformLocation(p, name);
  return out;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', {
      alpha: false, antialias: true, depth: false,
      premultipliedAlpha: true, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    this.lineProg = makeProgram(gl, LINE_VS, LINE_FS, ['aPos', 'aCol'], ['uMVP', 'uAlpha']);
    this.pointProg = makeProgram(gl, POINT_VS, POINT_FS, ['aPos', 'aCol', 'aSize'], ['uMVP', 'uScale', 'uAlpha']);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive, premultiplied in shaders
    this.buffers = {};
  }

  // geom: { pos: Float32Array, col: Uint8Array (RGBA), size?: Float32Array }
  createGeometry(name, geom, dynamic = false) {
    const gl = this.gl;
    const b = {
      count: geom.pos.length / 3,
      pos: gl.createBuffer(),
      col: gl.createBuffer(),
      size: null,
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
    gl.bufferData(gl.ARRAY_BUFFER, geom.pos, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.col);
    gl.bufferData(gl.ARRAY_BUFFER, geom.col, gl.STATIC_DRAW);
    if (geom.size) {
      b.size = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b.size);
      gl.bufferData(gl.ARRAY_BUFFER, geom.size, gl.STATIC_DRAW);
    }
    this.buffers[name] = b;
    return b;
  }

  updatePositions(name, pos) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[name].pos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
  }

  resize(w, h, dpr) {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.dpr = dpr;
  }

  clear() {
    const gl = this.gl;
    gl.clearColor(0.012, 0.02, 0.042, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  drawLines(name, mvp, alpha = 1, first = 0, count = null) {
    const gl = this.gl, p = this.lineProg, b = this.buffers[name];
    if (!b) return;
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.u.uMVP, false, mvp);
    gl.uniform1f(p.u.uAlpha, alpha);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
    gl.enableVertexAttribArray(p.a.aPos);
    gl.vertexAttribPointer(p.a.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.col);
    gl.enableVertexAttribArray(p.a.aCol);
    gl.vertexAttribPointer(p.a.aCol, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.drawArrays(gl.LINES, first, count === null ? b.count : count);
  }

  drawPoints(name, mvp, alpha = 1, first = 0, count = null) {
    const gl = this.gl, p = this.pointProg, b = this.buffers[name];
    if (!b) return;
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.u.uMVP, false, mvp);
    gl.uniform1f(p.u.uScale, this.dpr || 1);
    gl.uniform1f(p.u.uAlpha, alpha);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
    gl.enableVertexAttribArray(p.a.aPos);
    gl.vertexAttribPointer(p.a.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.col);
    gl.enableVertexAttribArray(p.a.aCol);
    gl.vertexAttribPointer(p.a.aCol, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.size);
    gl.enableVertexAttribArray(p.a.aSize);
    gl.vertexAttribPointer(p.a.aSize, 1, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, first, count === null ? b.count : count);
  }
}
