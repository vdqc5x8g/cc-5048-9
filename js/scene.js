// 带直线网格的三维静态场景 + 真实 GLSL ES 3.00 着色器。
// 场景物体全部固定在世界坐标中，演示期间不独立运动。

const SCENE_VS = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
uniform mat4 uMVP;
out vec3 vNormal;
out vec3 vWorldPos;
void main() {
  vNormal = aNormal;
  vWorldPos = aPosition;
  gl_Position = uMVP * vec4(aPosition, 1.0);
}`;

const SCENE_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorldPos;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  vec3 N = normalize(vNormal);
  vec3 L = normalize(vec3(0.4, 0.9, 0.3));
  float diff = max(dot(N, L), 0.0);
  vec3 ambient = uColor * 0.28;
  vec3 lit = ambient + uColor * (0.72 * diff);
  float dist = length(vWorldPos);
  float fog = smoothstep(12.0, 24.0, dist);
  vec3 fogColor = vec3(0.05, 0.07, 0.10);
  outColor = vec4(mix(lit, fogColor, fog), 1.0);
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=2) in vec3 aColor;
uniform mat4 uMVP;
out vec3 vColor;
out float vDist;
void main() {
  vColor = aColor;
  vDist = length(aPosition);
  gl_Position = uMVP * vec4(aPosition, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vDist;
out vec4 outColor;
void main() {
  float fog = smoothstep(12.0, 24.0, vDist);
  outColor = vec4(mix(vColor, vec3(0.05, 0.07, 0.10), fog), 1.0);
}`;

export function createProgram(gl, vsSource, fsSource) {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('着色器编译失败: ' + log + '\n' + src);
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl.FRAGMENT_SHADER, fsSource);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

function makeVBO(gl, data) {
  const bo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  return bo;
}

// 线段网格：收集成对端点
class LineBuilder {
  constructor() { this.pos = []; this.col = []; }
  add(a, b, color) {
    this.pos.push(...a, ...b);
    this.col.push(...color, ...color);
  }
}

const GRID_COLOR = [0.32, 0.55, 0.72];
const AXIS_X = [0.85, 0.35, 0.30];
const AXIS_Z = [0.35, 0.78, 0.45];
const WALL_COLOR = [0.40, 0.44, 0.60];

function buildGridLines() {
  const lb = new LineBuilder();
  const EYE_Y = -1.6;
  const R = 10;
  // 地面网格 y = EYE_Y
  for (let i = -R; i <= R; i++) {
    const cX = i === 0 ? AXIS_X : GRID_COLOR;
    lb.add([i, EYE_Y, -R], [i, EYE_Y, R], cX);
    const cZ = i === 0 ? AXIS_Z : GRID_COLOR;
    lb.add([-R, EYE_Y, i], [R, EYE_Y, i], cZ);
  }
  // 后墙 z = -10，y 从地面到 +6.4
  const WZ = -10;
  for (let i = -R; i <= R; i++) {
    lb.add([i, EYE_Y, WZ], [i, 6.4, WZ], i === 0 ? AXIS_X : WALL_COLOR);
  }
  for (let j = 0; j <= 8; j++) {
    const y = EYE_Y + j;
    lb.add([-R, y, WZ], [R, y, WZ], j === 0 ? AXIS_Z : WALL_COLOR);
  }
  // 侧墙 x = -10，帮助感知旋转
  const WX = -10;
  for (let i = -R; i <= R; i++) {
    lb.add([WX, EYE_Y, i], [WX, 6.4, i], i === 0 ? AXIS_Z : WALL_COLOR);
  }
  for (let j = 0; j <= 8; j++) {
    const y = EYE_Y + j;
    lb.add([WX, y, -R], [WX, y, R], WALL_COLOR);
  }
  return lb;
}

function buildCubes() {
  // 6 根彩色立柱，分布在半径 5 的圆周；index 0 位于世界 +X（声源同向）
  const colors = [
    [0.95, 0.35, 0.30],
    [0.95, 0.72, 0.25],
    [0.45, 0.85, 0.35],
    [0.30, 0.80, 0.90],
    [0.45, 0.50, 0.95],
    [0.85, 0.45, 0.90],
  ];
  const EYE_Y = -1.6;
  const cubes = [];
  const half = 0.22;
  const top = 2.4;
  for (let k = 0; k < 6; k++) {
    const ang = (k / 6) * Math.PI * 2;
    const cx = 5 * Math.cos(ang);
    const cz = 5 * Math.sin(ang);
    const x0 = cx - half, x1 = cx + half;
    const z0 = cz - half, z1 = cz + half;
    const y0 = EYE_Y, y1 = top;
    // 24 顶点（每面独立法线）
    const pos = [];
    const nrm = [];
    const face = (p, n) => { for (const v of p) pos.push(...v); for (let i = 0; i < 6; i++) nrm.push(...n); };
    face([[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y0,z1],[x1,y1,z1],[x0,y1,z1]], [0,0,1]);
    face([[x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y0,z0],[x0,y1,z0],[x1,y1,z0]], [0,0,-1]);
    face([[x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y0,z1],[x1,y1,z0],[x1,y1,z1]], [1,0,0]);
    face([[x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y0,z0],[x0,y1,z1],[x0,y1,z0]], [-1,0,0]);
    face([[x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z1],[x1,y1,z0],[x0,y1,z0]], [0,1,0]);
    face([[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z0],[x1,y0,z1],[x0,y0,z1]], [0,-1,0]);
    cubes.push({ pos, nrm, color: colors[k], angleDeg: (ang * 180) / Math.PI });
  }
  return cubes;
}

export function createScene(gl) {
  const sceneProg = createProgram(gl, SCENE_VS, SCENE_FS);
  const lineProg = createProgram(gl, LINE_VS, LINE_FS);

  const lines = buildGridLines();
  const linePos = makeVBO(gl, lines.pos);
  const lineCol = makeVBO(gl, lines.col);
  const lineVAO = gl.createVertexArray();
  gl.bindVertexArray(lineVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, linePos);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineCol);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const cubes = buildCubes().map((c) => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pbo = makeVBO(gl, c.pos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const nbo = makeVBO(gl, c.nrm);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, color: c.color, angleDeg: c.angleDeg, count: c.pos.length / 3 };
  });

  const uScene = {
    mvp: gl.getUniformLocation(sceneProg, 'uMVP'),
    color: gl.getUniformLocation(sceneProg, 'uColor'),
  };
  const uLine = { mvp: gl.getUniformLocation(lineProg, 'uMVP') };

  return {
    draw(mvpColMajor) {
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(uLine.mvp, false, mvpColMajor);
      gl.bindVertexArray(lineVAO);
      gl.drawArrays(gl.LINES, 0, lines.pos.length / 3);

      gl.useProgram(sceneProg);
      gl.uniformMatrix4fv(uScene.mvp, false, mvpColMajor);
      for (const c of cubes) {
        gl.uniform3fv(uScene.color, c.color);
        gl.bindVertexArray(c.vao);
        gl.drawArrays(gl.TRIANGLES, 0, c.count);
      }
      gl.bindVertexArray(null);
    },
  };
}

// 全屏三角形 VAO（location 0 输出 NDC 位置与 uv）
export function createFullscreenQuad(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const bo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1, 0, 0,
      3, -1, 2, 0,
      -1, 3, 0, 2,
    ]),
    gl.STATIC_DRAW
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
  gl.bindVertexArray(null);
  return vao;
}
