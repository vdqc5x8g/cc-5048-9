# 转头重投影 · 空间音画视窗

快速转头场景的**迟到姿态修正（旋转重投影 / 类 ATW）**演示：
场景按较早姿态完成渲染，在显示前取得更新朝向并由片段着色器对图像做旋转重投影，
与未经修正的延迟画面、以最新姿态直接渲染的参考帧三窗同步对照。

## 图形入口（主要交付）

```bash
node cli/serve.js
# 浏览器打开 http://localhost:8080/  →  index.html
```

需要支持 WebGL2 的现代浏览器；零第三方依赖。

## 关键约束（与需求逐条对应）

- 明确区分并逐帧记录 **姿态采样 `t_s`、渲染 `t_r`、呈现 `t_p`** 三个时刻。
- 全链路同一右手坐标系与同一透视投影矩阵（`js/math3d.js`、`js/reproject.js`）。
- 原始渲染按**固定间隔**触发，重投影在显示帧执行；不以提高渲染频率替代修正算法。
- 超出旧帧可用视野的区域：默认红色斜纹标记 + 黄色边界描线；
  另提供声明式边缘钳取模式，不声称正确重建。
- 可重复正弦 yaw 轨迹（可加 10 s 角速度扫描）+ 带直线网格与彩色立柱的三维静态场景。
- 误差指标（RMS 色差、越界占比）以最新姿态直渲帧为参考，随角速度变化绘曲线。
- 真实 GLSL ES 3.00 着色器（场景光照/雾、网格线、重投影），按钮只改状态与 uniform，
  无固定画面数据。
- 仅声明修正**头部旋转**；头部平移、场景物体独立运动不在修复范围内（界面有显著声明）。
- 空间音频：世界固定 HRTF 声源，听者随最新姿态旋转。
- 后端迁移：帧令牌显式绑定颜色纹理/生成朝向/呈现姿态，环形槽代际守卫拒绝把
  当前槽内容当历史图像；手动栅栏单步放行 + wait/discard 策略、双眼不对称角标
  翻转定位、含纹理复用的最小重放，见 `docs/migration.zh.md`。
- CLI 仅做静态服务、数值表与迁移核对，详见 `docs/cli.zh.md`。

## 文档

- `docs/usage.zh.md` — 图形入口、界面操作与实验流程
- `docs/method.zh.md` — 时刻定义、重投影数学、边缘处理与失效边界
- `docs/migration.zh.md` — 后端适配器、帧令牌/代际、栅栏策略与翻转定位
- `docs/cli.zh.md` — 命令行辅助工具

## 目录

```
index.html            图形入口（三视窗 + 控制台 + 迁移核对面板）
css/style.css
js/math3d.js          四元数/矩阵/投影（浏览器与 CLI 共用）
js/trajectory.js      可重复轨迹与角速度扫描（纯函数，支持三轴）
js/scene.js           网格三维场景与场景着色器
js/reproject.js       重投影/拷贝着色器与帧缓冲（含翻转注入）
js/markers.js         双眼不对称角标、帧号条编码与翻转诊断
js/cpu-backend.js     CPU 软件图形后端（无头可运行，同适配器接口）
js/webgl-backend.js   WebGL2 后端适配器（fenceSync 栅栏 + 代际令牌）
js/frame-pool.js      帧池：环形槽代际、栅栏闸门、wait/discard、旧记录读取
js/replay.js          最小重放序列化与代际断言
js/verifier.js        七个迁移核对场景（交叉完成/快速转头/槽复用/翻转…）
js/migration-panel.js 页面内迁移核对面板控制器
js/audio.js           HRTF 空间音频
js/main.js            时钟、固定渲染调度、三视窗、指标、界面联动
cli/serve.js          零依赖静态服务
cli/atw-cli.js        轨迹表 / 边界误差数值表（辅助）
cli/migrate-verify.js 后端迁移无头核对（npm run migrate）
```

## 迁移核对

```bash
npm run migrate       # 七个场景全部通过才算迁移正确（退出码非 0 即失败）
```
