# 命令行辅助工具说明

> 定位：CLI **仅辅助**转头重投影演示。重投影画面与边界由 `index.html`
> 中的 WebGL2 着色器实时生成，CLI 不产出、也不能替代任何画面。

两个脚本均只使用 Node 内置模块，无需安装依赖，要求 Node ≥ 18。

## 1. 静态服务 `cli/serve.js`

ES 模块必须通过 http 提供，`file://` 打开会被浏览器阻止。

```bash
node cli/serve.js                 # http://localhost:8080/
node cli/serve.js --port 9000     # 自定义端口
node cli/serve.js --root /other   # 自定义根目录（默认仓库根）
```

图形入口：启动后访问 `/`（即 `index.html`）。脚本带目录穿越防护。

## 2. 数值表 `cli/atw-cli.js`

### 2.1 轨迹表 `trajectory-csv`

输出与页面完全相同的可重复轨迹：

```bash
node cli/atw-cli.js trajectory-csv --duration 10 --rate 100 \
  --amp 45 --freq 0.8 --phase 0
# 扫描轨迹（频率随时间爬升，与页面“角速度扫描”按钮同公式）
node cli/atw-cli.js trajectory-csv --sweep --duration 10
# 写入文件
node cli/atw-cli.js trajectory-csv --out traj.csv
```

字段：`tSec, yawDeg, yawRateDegPerSec, quatX, quatY, quatZ, quatW`。

### 2.2 边界误差表 `error-table`

按页面同一时刻定义（`t_s = t_r − Δ_SR`、旧帧选择 `t_r ≤ t_p − latency`）
和与重投影片段着色器一致的射线投影公式，逐显示步长数值化统计：

```bash
node cli/atw-cli.js error-table --duration 10 --latency 100 \
  --render-interval 66 --sr 5 --width 640 --height 480 --fovy 72 --step 33
```

字段：

| 字段 | 含义 |
| --- | --- |
| `tPresentMs` | 呈现时刻 `t_p` |
| `omegaDegPerSec` | 该时刻头部角速度 |
| `deltaYawDeg` | 重投影修正角度（Δq 的旋转角） |
| `edgeFrac` | 落在旧纹理 `[0,1]` 之外的像素比例（对应页面斜纹/越界面积） |
| `boundaryFrac` | 邻域跨越纹理边界的像素比例（对应黄色边界描线） |
| `insideFrac` | 可从旧纹理采样的有效比例 |
| `tSampleMs, tRenderMs, e2eMs` | 采样/渲染时刻与端到端延迟 |

该表是**边界几何的独立数值核算**，用于与页面指标卡、导出 CSV 交叉对照，
不包含也不依赖任何渲染画面。

## 3. 图形后端迁移核对 `migrate-verify`

后端迁移（帧令牌、环形槽代际、迟到栅栏、不对称角标）的无头核对，使用与
WebGL 适配器同接口的 CPU 软件后端，零依赖、可重复：

```bash
node cli/migrate-verify.js run                       # 全部七个场景
node cli/migrate-verify.js interleave                # 两帧交叉完成 + 栅栏单步放行
node cli/migrate-verify.js corners                   # 旧/新工程双眼四角读取
node cli/migrate-verify.js flip --mode origin        # 纹理原点翻转定位
node cli/migrate-verify.js flip --mode matrix        # 矩阵翻转定位
node cli/migrate-verify.js replay --out replay.json  # 含纹理复用的最小重放
```

可选参数：`--width 160 --height 120 --slots 2`。退出码非 0 表示有场景失败。
设计与判据见 `docs/migration.zh.md`。

## 4. 语法自检

```bash
npm run check
```

对全部浏览器模块与 CLI 脚本执行 `node --check`。
