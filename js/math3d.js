// 右手坐标系：+X 右，+Y 上，-Z 前（相机默认看向 -Z）。
// 四元数约定 (x, y, z, w)。

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function deg2rad(d) {
  return (d * Math.PI) / 180;
}

export function rad2deg(r) {
  return (r * 180) / Math.PI;
}

// 绕固定轴的四元数（右手定则，angle 为弧度）
export function quatAxisAngle(axis, angle) {
  const h = angle * 0.5;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

// yaw 绕 +Y（正角向左转），pitch 绕 +X，roll 绕 +Z
export function quatYawPitchRoll(yaw, pitch = 0, roll = 0) {
  const qy = quatAxisAngle([0, 1, 0], yaw);
  const qp = quatAxisAngle([1, 0, 0], pitch);
  const qr = quatAxisAngle([0, 0, 1], roll);
  return quatMul(quatMul(qy, qp), qr);
}

export function quatMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatConjugate(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function quatRotate(q, v) {
  // v' = q * v * q^-1（单位四元数下逆=共轭）
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

// 行主序 4x4 透视投影（OpenGL/GL 风格 NDC：z ∈ [-1,1]）
export function perspective(fovYRad, aspect, near, far) {
  const f = 1 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function identity4() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

// 视图矩阵：相机位于原点、仅有朝向 q（本演示头部位置不动，不处理平移）。
// 行主序输出，直接供 uniformMatrix4fv 使用（WebGL 期望列主序，故最后转置上传）。
export function viewMatrix(q) {
  // 旋转矩阵 R（世界->相机 = q^-1），列主序构造后转置为行主序。
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  // 列主序 R^T：
  const colMajor = [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
  // colMajor 是 q 旋转矩阵 R 的列主序存储；视图矩阵需要 R^T，
  // 而 R 的列主序排列即 R^T 的行主序，直接返回即可。
  return new Float32Array(colMajor);
}

// 行主序矩阵相乘 out = a * b
export function mul4(a, b) {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = s;
    }
  }
  return out;
}

// 以列主序返回（供 uniformMatrix4fv(..., false, ...)）
export function toColumnMajor(m) {
  return new Float32Array([
    m[0], m[4], m[8], m[12],
    m[1], m[5], m[9], m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15],
  ]);
}
