// 不对称角标：每个角的标识、配色、朝向条纹均不同，且把眼别与帧号编入纹理。
// 设计目的：矩阵或纹理原点翻转时，中心像素可能碰巧一致，
// 但四角的不对称编码一定能指出“哪只眼的哪个角先错”，而不是依赖中心像素。
//
// 一个角标由 PATCH×PATCH 个格（cell）组成，落在画面的某个角：
//   - 角基色：四角互不相同
//   - L 形朝向条纹：沿该角的两条屏边，翻转后条纹位置改变
//   - 数据格（dataBits 位）：编码 眼别(1) + 角编号(2)，读回后与期望比对
// 画面顶边中部另有一条帧号条：12 位二进制编码 seq % 4096，
// 用于核对“实际呈现帧号”，并防止把环形槽当前内容误当历史图像。

export const EYE = Object.freeze({ LEFT: 0, RIGHT: 1 });
export const CORNER = Object.freeze({ TL: 0, TR: 1, BR: 2, BL: 3 });

export const EYE_NAME = Object.freeze({ 0: '左眼', 1: '右眼' });
export const CORNER_NAME = Object.freeze({ 0: '左上', 1: '右上', 2: '右下', 3: '左下' });

// 四角基色（刻意两两不同，且不是灰度对称色）
export const CORNER_BASE = Object.freeze([
  [214, 62, 58],   // TL 红
  [224, 168, 38],  // TR 琥珀
  [46, 158, 96],   // BR 绿
  [64, 118, 220],  // BL 蓝
]);

export const PATCH_CELLS = 6;   // 6×6 格
export const CELL_PX = 4;       // 每格 4 像素（CPU 纹理默认 96×96 时仍清晰）
export const PATCH_PX = PATCH_CELLS * CELL_PX;
const DATA_BITS = 3;            // bit0 = 眼别, bit1..2 = 角编号

// 帧号条（底边中部，避免与顶角标重叠）
const SEQ_BITS = 10;
export const SEQ_CELL_H = 2;
export const SEQ_TOTAL_CELLS = SEQ_BITS + 2; // 两端各一个起始格

const BIT_ON = [245, 245, 245];
const BIT_OFF = [28, 30, 36];
const STRIPE = [18, 18, 22];

function bitAt(value, bit) {
  return (value >> bit) & 1;
}

// 格值（RGB 或 null 表示该格为基色背景）
// 数据位布局刻意放在角标内侧（远离屏边），翻转后错位更明显。
function cellColor(eye, corner, cy, cx) {
  const base = CORNER_BASE[corner];
  // L 形条纹：沿该角对应的两条边各占 1 格宽
  const onTopEdge = corner === CORNER.TL || corner === CORNER.TR;
  const onLeftEdge = corner === CORNER.TL || corner === CORNER.BL;
  const edgeRow = onTopEdge ? cy === 0 : cy === PATCH_CELLS - 1;
  const edgeCol = onLeftEdge ? cx === 0 : cx === PATCH_CELLS - 1;
  if (edgeRow || edgeCol) return STRIPE;

  // 数据区：取内部 4×4 中的前 DATA_BITS 个位置（逐行）
  const inner = 4;
  const innerIdx = (cy - 1) * inner + (cx - 1);
  if (innerIdx < DATA_BITS) {
    const code = (eye & 1) | ((corner & 3) << 1);
    return bitAt(code, innerIdx) ? BIT_ON : BIT_OFF;
  }
  return base;
}

// 角标在图像中的左上角像素坐标
export function patchOrigin(corner, width, height, margin = 2) {
  switch (corner) {
    case CORNER.TL: return [margin, margin];
    case CORNER.TR: return [width - margin - PATCH_PX, margin];
    case CORNER.BR: return [width - margin - PATCH_PX, height - margin - PATCH_PX];
    case CORNER.BL: return [margin, height - margin - PATCH_PX];
    default: throw new Error('非法角编号: ' + corner);
  }
}

// 在 ImageData 风格的像素缓冲（Uint8ClampedArray/RGBA）上画一个角标
export function drawCornerMarker(pixels, width, height, eye, corner) {
  const [ox, oy] = patchOrigin(corner, width, height);
  for (let cy = 0; cy < PATCH_CELLS; cy++) {
    for (let cx = 0; cx < PATCH_CELLS; cx++) {
      const [r, g, b] = cellColor(eye, corner, cy, cx);
      for (let dy = 0; dy < CELL_PX; dy++) {
        for (let dx = 0; dx < CELL_PX; dx++) {
          const x = ox + cx * CELL_PX + dx;
          const y = oy + cy * CELL_PX + dy;
          const o = (y * width + x) * 4;
          pixels[o] = r;
          pixels[o + 1] = g;
          pixels[o + 2] = b;
          pixels[o + 3] = 255;
        }
      }
    }
  }
}

// 底边中部帧号条：起始格(亮)-SEQ_BITS 位数据-结束格(暗)
export function drawSeqStrip(pixels, width, height, seq) {
  const code = seq & ((1 << SEQ_BITS) - 1);
  const cell = CELL_PX;
  const stripW = SEQ_TOTAL_CELLS * cell;
  const x0 = Math.floor((width - stripW) / 2);
  const stripH = SEQ_CELL_H * cell;
  const y0 = height - 2 - stripH;
  for (let i = 0; i < SEQ_TOTAL_CELLS; i++) {
    let col;
    if (i === 0) col = BIT_ON;
    else if (i === SEQ_TOTAL_CELLS - 1) col = BIT_OFF;
    else col = bitAt(code, i - 1) ? BIT_ON : BIT_OFF; // bit0(LSB) 在最左数据格
    for (let dy = 0; dy < stripH; dy++) {
      for (let dx = 0; dx < cell; dx++) {
        const o = ((y0 + dy) * width + x0 + i * cell + dx) * 4;
        pixels[o] = col[0];
        pixels[o + 1] = col[1];
        pixels[o + 2] = col[2];
        pixels[o + 3] = 255;
      }
    }
  }
}

// 在整幅 RGBA 缓冲上画齐四个角标 + 帧号条
export function stampFrame(pixels, width, height, eye, seq) {
  for (let c = 0; c < 4; c++) drawCornerMarker(pixels, width, height, eye, c);
  drawSeqStrip(pixels, width, height, seq);
}

function isLightish(r, g, b) {
  return (r + g + b) / 3 > 150;
}

// 从缓冲读回某角的数据位编码
function readCodeAt(pixels, width, originX, originY) {
  let code = 0;
  const inner = 4;
  for (let bit = 0; bit < DATA_BITS; bit++) {
    const cy = 1 + Math.floor(bit / inner);
    const cx = 1 + (bit % inner);
    // 格 (cx, cy) 的像素起点 + 半格中心
    const x = originX + (cx * CELL_PX) + (CELL_PX >> 1);
    const y = originY + (cy * CELL_PX) + (CELL_PX >> 1);
    const o = (y * width + x) * 4;
    if (isLightish(pixels[o], pixels[o + 1], pixels[o + 2])) code |= 1 << bit;
  }
  return code;
}

// 读回某物理角（screenCorner）上实际出现的标识，返回 {eye, corner} 或 null
export function readMarkerAt(pixels, width, height, screenCorner) {
  const [ox, oy] = patchOrigin(screenCorner, width, height);
  const code = readCodeAt(pixels, width, ox, oy);
  return { eye: code & 1, corner: (code >> 1) & 3 };
}// 读回四个物理角的实际标识
export function readAllMarkers(pixels, width, height) {
  return [CORNER.TL, CORNER.TR, CORNER.BR, CORNER.BL].map((sc) => ({
    screenCorner: sc,
    ...readMarkerAt(pixels, width, height, sc),
  }));
}

// 读回帧号条编码的帧号（找不到起始格返回 null）
export function readSeqStrip(pixels, width, height) {
  const cell = CELL_PX;
  const stripW = SEQ_TOTAL_CELLS * cell;
  const x0 = Math.floor((width - stripW) / 2);
  const stripH = SEQ_CELL_H * cell;
  const y = height - 2 - stripH + (cell >> 1); // 条纹中部
  const at = (i) => {
    const o = (y * width + x0 + i * cell + (cell >> 1)) * 4;
    return isLightish(pixels[o], pixels[o + 1], pixels[o + 2]);
  };
  if (!at(0) || at(SEQ_TOTAL_CELLS - 1)) return null;
  // 数据格按 bit0（LSB）在前排列，与 drawSeqStrip 的写入顺序保持一致
  let code = 0;
  for (let i = 1; i <= SEQ_BITS; i++) {
    if (at(i)) code |= 1 << (i - 1);
  }
  return code;
}

// 判定某物理角当前像素是否落在重投影无效区（RGBA alpha=0 约定）
export function markerIsInvalid(pixels, width, height, screenCorner) {
  const [ox, oy] = patchOrigin(screenCorner, width, height);
  const x = ox + (PATCH_PX >> 1);
  const y = oy + (PATCH_PX >> 1);
  return pixels[(y * width + x) * 4 + 3] === 0;
}

// 翻转诊断：期望物理角 screenCorner 上应出现逻辑角 corner、眼别 eye。
// 不匹配时给出人类可读的“哪只眼的哪个角先错”，并推断翻转类型。
const FLIP_BY_CORNER = Object.freeze({
  0: { 1: '水平翻转(左右镜像)', 3: '垂直翻转(上下镜像)', 2: '旋转180°(双轴翻转)' },
  1: { 0: '水平翻转(左右镜像)', 2: '垂直翻转(上下镜像)', 3: '旋转180°(双轴翻转)' },
  2: { 3: '水平翻转(左右镜像)', 1: '垂直翻转(上下镜像)', 0: '旋转180°(双轴翻转)' },
  3: { 2: '水平翻转(左右镜像)', 0: '垂直翻转(上下镜像)', 1: '旋转180°(双轴翻转)' },
});

export function diagnoseMarkers(markers, expectedEye) {
  const failures = [];
  for (const m of markers) {
    const ok = m.eye === expectedEye && m.corner === m.screenCorner;
    if (!ok) {
      const note = m.eye !== expectedEye
        ? `眼别读到 ${EYE_NAME[m.eye]}，期望 ${EYE_NAME[expectedEye]}`
        : (FLIP_BY_CORNER[m.screenCorner]?.[m.corner] || '角标识错位');
      failures.push({
        eye: expectedEye,
        screenCorner: m.screenCorner,
        gotCorner: m.corner,
        gotEye: m.eye,
        message: `${EYE_NAME[expectedEye]}${CORNER_NAME[m.screenCorner]}角先错：读到的是${EYE_NAME[m.eye]}${CORNER_NAME[m.corner]}角标识（${note}）`,
      });
    }
  }
  return { ok: failures.length === 0, failures };
}
