# Cue · mmt 手工矢量动画

此包是已确认视觉效果的手工矢量版。五件商品以 88 个平滑路径和柔和线性渐变绘制，保留运动鞋、高跟鞋、童鞋、拖鞋及上衣的造型、配色与摆放。鞋盒、场记板、Cue 字标、三个展开色面及动画布局沿用已确认版本。

展开 **300 ms**、收起 **217 ms**；商品与色面同步运动，起点跟随移动中的鞋盒开口。画板为透明的 `1200 × 600`，Cue 字标可随背景切换颜色。

## 打开示例

解压后直接打开 [index.html](index.html)。示例使用内联 SVG 和本包的 JavaScript，运行不需要网络、npm、Rive 运行时、WASM、位图或字体文件。

示例支持悬停展开、移开收回、点击固定、再次点击或 Escape 收回、循环播放、首尾姿态、手动进度以及浅色、深色、透明网格背景。系统启用减少动态效果时，交互直接切换首尾姿态。下方输入框用于展示吉祥物的放置位置。

## 文件与体积

| 文件 | 用途 | 大小 |
| --- | --- | ---: |
| [cue-mmt.svg](cue-mmt.svg) | 完整画面、渐变及动画首尾姿态数据，所有图形均为矢量 | 63,794 B |
| [cue-mmt.js](cue-mmt.js) | 轻量 SVG 动画控制器 | 见 MANIFEST.json |
| [index.html](index.html) | 可直接打开的完整 SVG 接入示例 | 见 MANIFEST.json |
| [preview-svg.js](preview-svg.js)、[preview.css](preview.css) | 示例的交互和页面样式 | 见 MANIFEST.json |
| [animation/build/cue-mmt-vector-refined.riv](animation/build/cue-mmt-vector-refined.riv) | 纯矢量 Rive 动画；使用 Rive 的项目可选用 | 68,648 B |
| [assets/svg](assets/svg) | 五件商品的独立手工 SVG，可单独编辑 | 合计 39,132 B |
| [animation/scene.rml](animation/scene.rml) | 完整 Rive 场景、时间轴、状态机源码 | 见 MANIFEST.json |
| [animation/layout.xml](animation/layout.xml) | 原布局、字标路径、运动结构及商品占位模板 | 见 MANIFEST.json |
| [animation/build_vector.py](animation/build_vector.py) | 将商品 SVG 导入模板，生成 RML | 见 MANIFEST.json |
| [build_svg.py](build_svg.py)、[index.template.html](index.template.html) | 从 RML 重新生成 SVG 与完整示例页面 | 见 MANIFEST.json |
| [animation/animation-interface.json](animation/animation-interface.json) | Rive 控制字段、时长、锚点与商品布局 | 见 MANIFEST.json |

原位图 Rive 为 3,106,586 B；当前 Rive 为 68,648 B，减少 **97.79%**。完整 SVG 和五件商品 SVG 均没有嵌入 PNG、base64 图像或字体。Rive Web 运行时由使用 Rive 的项目自行安装，本包默认使用 SVG 示例。

## SVG 接入

将 `cue-mmt.svg` 的完整 `<svg>…</svg>` 内联到页面，并在使用控制器之前引入 `cue-mmt.js`。可直接参考 `index.html` 中的结构。`<img src="cue-mmt.svg">` 适合显示静态首帧；交互动画需要控制器访问内联 SVG 中的元素。

```html
<script src="./cue-mmt.js" defer></script>
```

待 DOM 和脚本加载后：

```js
const mascot = new CueMascot(document.querySelector('.cue-mascot'));

// 根据交互状态展开或收起。
mascot.setExpanded(true);

// 深色背景下，只改变 Cue 字标。
mascot.setColor('#f4f1e9');

// 组件卸载时调用。
// mascot.destroy();
```

| 方法 | 行为 |
| --- | --- |
| `setExpanded(true / false)` | 以 300 / 217 ms 展开或收起；过渡中可再次切换 |
| `setExpanded(value, { animate: false })` | 直接切换首尾姿态 |
| `setProgress(number)` | 直接设置 `0–100` 的展开进度；超出范围会限制到边界 |
| `setColor(cssColor)` | 改变 Cue 字标颜色；浅色背景使用 `#171818`，深色背景使用 `#f4f1e9` |
| `play()` | 播放 3.55 秒的展示循环，包含首尾停留 |
| `stop()` | 停在当前姿态 |
| `destroy()` | 清除动画回调和控制器监听，用于组件卸载 |

`setExpanded` 与 `setProgress` 会停止自动循环。鞋盒上的 mmt 印字和商品配色不受 `setColor` 影响。示例的悬停、点击、进度、背景控制见 `preview-svg.js`。

SVG 使用 `viewBox` 适应容器尺寸。保持容器宽高比 `2:1`，可沿用以下样式：

```css
.cue-mascot {
  display: block;
  width: 100%;
  height: auto;
}
```

## Rive 接入

Rive 文件保留原控制接口：画板 `Cue Unboxing`、默认状态机 `Showcase`、View Model `CueMascot`。

| 属性 | 类型 | 行为 |
| --- | --- | --- |
| `mode` | number | `0` 自动循环，`1` 交互，`2` 手动进度 |
| `expanded` | boolean | `mode=1` 时控制展开、收回 |
| `progress` | number | `mode=2` 时控制 `0–100` 展开进度 |
| `textColor` | color | Cue 字标颜色；浅色背景 `0xff171818`，深色背景 `0xfff4f1e9` |

另有 `Interactive` 和 `Preview` 状态机，分别只消费 `expanded` 和 `progress`。同一实例使用一个状态机。

原预览使用 `@rive-app/webgl2` **2.42.1**。在使用该运行时的项目中：

```js
import { Rive } from '@rive-app/webgl2';

const canvas = document.querySelector('canvas');
const animation = new Rive({
  canvas,
  src: './animation/build/cue-mmt-vector-refined.riv',
  stateMachine: 'Showcase',
  autoplay: true,
  autoBind: true,
  onLoad() {
    animation.resizeDrawingSurfaceToCanvas();
    const model = animation.viewModelInstance;
    model.number('mode').value = 1;
    model.boolean('expanded').value = false;
    model.color('textColor').value = 0xff171818;
  },
});
```

在 `onLoad` 完成后，通过 `animation.viewModelInstance.boolean('expanded').value` 控制开合。容器大小变化时调用 `resizeDrawingSurfaceToCanvas()`，组件卸载时调用 `cleanup()`。运行时加载方式见 [Rive Web 文档](https://rive.app/docs/runtimes/web/web-js)。

## 编辑与重建

重建依赖 Python 3.9+ 和 [Rive CLI](https://rive.app/docs/cli/overview)；本包的 Rive 文件使用 CLI **1.0.2** 编译。两个 Python 脚本仅使用标准库，不需要原 PNG、字体文件或其他目录。

在代码包根目录执行：

```bash
python3 animation/build_vector.py
rive animation --once
python3 build_svg.py
```

第一步从 `animation/layout.xml` 和 `assets/svg/` 生成 `animation/scene.rml`。第二步生成 Rive 文件。第三步生成 `cue-mmt.svg` 与 `index.html`。

修改商品时编辑 `assets/svg/*.svg`；修改布局、字标或运动时编辑 `animation/layout.xml`；修改示例页面结构时编辑 `index.template.html`。生成脚本会覆盖对应的生成文件。

商品导入器支持闭合 `M / L / C / Z` 路径、实色填充以及 `userSpaceOnUse` 线性渐变，保留填充和渐变节点透明度。当前素材使用 `1254 × 1254` 画布；该画布尺寸是导入器的约定。

## 来源与交付记录

Cue 字标由 Source Serif 4 Semibold Italic 的实际字形轮廓转换，已经成为普通矢量路径，无字体加载依赖。来源说明见 [wordmark-provenance.json](animation/wordmark-provenance.json)，随包保留 [Source Serif 字体许可](licenses/Source-Serif-OFL.md)。

[compile-report.json](animation/compile-report.json) 记录 Rive 编译结果与运动结构核对；[MANIFEST.json](MANIFEST.json) 记录包内文件大小和 SHA-256。视觉以已确认的手工矢量预览为准。本包仅导出文件与代码，未接入业务项目。
