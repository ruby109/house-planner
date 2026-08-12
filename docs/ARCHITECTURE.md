# house-planner 架构设计

> 本文档是所有编码工作的统一规格。实现时如需偏离，先在 PR/汇报中说明理由。
> 产品背景与调研结论见规划文档；一句话定位：**免注册、自动保存、免费导出的纯 2D Web 户型模拟器**（日式 910mm 模数，后接 AI 户型图识别）。

## 0. 技术栈（已定，不讨论）

React 18 + TypeScript(strict) + Vite + react-konva(Konva) + Zustand + zundo + zod。
包管理 npm。Windows 开发环境。无后端（Milestone 3 才加一个 serverless 代理）。

## 1. 坐标系与单位（全项目最重要的约定）

- **文档坐标一律为 mm，整数**。x 向右，y 向下（与屏幕一致）。
- 渲染时经 Stage 的 `scale`（px/mm）与 `position` 换算成屏幕像素。**除 Stage 的 scale/position 外，任何组件不得自行做 mm→px 换算**；Konva 节点的坐标直接写 mm 值。
- 网格：`GRID = 910`（1 间/半间模数）。吸附步长只支持 910 / 455 / 100 / 1（自由），默认 `HALF_GRID = 455`，全部保持整数。
- 面积显示：畳（1 帖 = 1.62㎡ = 910×1820mm）与 ㎡ 双显示；显示单位由 uiStore 的 `displayUnit: 'ja' | 'metric'` 控制，只影响格式化，不影响存储。
- 所有格式化函数集中在 `src/utils/units.ts`。

## 2. 数据模型（`src/model/types.ts`）

单一 JSON 文档 `PlanDoc`，编辑器、存档、AI 识别共用。zod schema 在 `src/model/schema.ts` 与之一一对应（用 `z.infer` 导出类型，types.ts 只 re-export，避免双维护）。

```ts
type Pt = { x: number; y: number };            // mm

interface PlanDoc {
  version: 1;
  meta: { name: string; gridSize: number; createdAt: string; updatedAt: string };
  underlay: Underlay | null;
  walls: Wall[];
  openings: Opening[];
  structures: Structure[];      // 柱 + 梁
  rooms: Room[];
  furniture: Furniture[];
  annotations: Annotation[];
}

interface Underlay {            // Milestone 2 实现，schema 先定义
  imageDataUrl: string;
  opacity: number;              // 0..1
  mmPerPixel: number;           // 比例标定结果
  offset: Pt; rotation: number; locked: boolean;
}

interface Wall {
  id: string;
  start: Pt; end: Pt;           // 中心线
  // v1 无厚度概念：渲染固定视觉宽度 WALL_VISUAL_WIDTH = 100mm
}

interface Opening {
  id: string;
  wallId: string;
  type: 'door' | 'sliding_door' | 'window' | 'opening';  // 开き戸/引き戸/窗/垂れ壁なし开口
  offset: number;               // 沿墙从 start 起到洞口中心的距离 mm
  width: number;                // mm
  swing?: 'in_left' | 'in_right' | 'out_left' | 'out_right';  // 仅 door
}

interface Structure {
  id: string;
  kind: 'column' | 'beam';
  position: Pt;                 // 矩形中心
  width: number; depth: number; // mm；柱默认 105×105，梁默认 910×300
  rotation: number;             // 度
}

interface Room {
  id: string;
  name: string;                 // LDK / 洋室 / 和室 …
  polygon: Pt[];
  floor: 'flooring' | 'tatami' | 'tile' | 'other';
}

interface Furniture {
  id: string;
  catalogId: string | null;     // null = 自定义
  name: string;
  size: { w: number; d: number };  // 俯视 w×d mm
  position: Pt;                 // 中心
  rotation: number;             // 度，90° 步进 + 自由旋转都允许
  color: string;
  locked: boolean;
}

interface Annotation {
  id: string;
  type: 'dimension' | 'text';
  // dimension: from/to/offsetDistance；text: position/text
  ...
}
```

约定：

- id 用 `nanoid(8)`（或自写 8 位随机），前缀区分类型：`w_`, `o_`, `s_`, `r_`, `f_`, `a_`。
- **AI 识别输出 = `Pick<PlanDoc, 'walls'|'openings'|'structures'|'rooms'>`**（且 structures 只出 column）。schema 保持对 LLM 友好：字段少、语义直白。
- 家具库 `src/model/catalog.ts`：静态数组 `{ catalogId, name, nameJa, w, d, color, category }`，初版收录约 30 件日本常见家具的标准尺寸（单人床 970×1950、双人床 1400×1950、布团 1000×2000、こたつ 750×750、冰箱 600×650、洗衣机 600×600、书桌 1100×600、餐桌 2/4 人、沙发 2/3 人、衣柜、电视柜、书架等），category: bed/table/seating/storage/appliance/other。

## 3. 状态管理（`src/store/`）

两个 store，职责严格分离：

### planStore（可撤销的文档状态）

- 内容：`doc: PlanDoc` + 全部修改 action（addWall、updateWall、removeWall、addOpening、moveFurniture、…）。
- 用 `zundo` 的 `temporal` 中间件包裹，**只对 doc 做历史记录**；`partialize` 排除任何 UI 状态。
- 拖拽中间态不进历史：拖拽过程中用 Konva 节点自身位置（不 commit），`onDragEnd`/`onTransformEnd` 才写 store —— 这是保证 undo 粒度正确的关键约定。
- action 按领域拆分文件（wallsActions.ts、furnitureActions.ts…）再在 planStore.ts 组装，方便多 agent 并行改动不冲突。

### uiStore（不可撤销的编辑器状态）

- `activeTool: 'select' | 'wall' | 'door' | 'sliding_door' | 'window' | 'column' | 'beam' | 'furniture_place'`
- `selection: string[]`（选中元素 id；跨类型统一放一个数组）
- `snapStep: 455 | 910 | 100 | 1`、`snapEnabled: boolean`
- `displayUnit: 'ja' | 'metric'`
- `zoom / pan` 由 PlanCanvas 内部管理（受控于 uiStore 亦可，实现者定，但要暴露「适应视图 fit」action）
- `pendingFurniture: catalogId | custom size`（家具放置模式的待放对象）

## 4. 画布结构（`src/components/canvas/`）

```
PlanCanvas.tsx        Stage：滚轮缩放(以指针为中心)、空格/中键拖拽平移、pointer 事件按 activeTool 分发
  GridLayer           910 网格线（主线）+ 455 细分线（次线），listening={false}，随缩放调整密度
  UnderlayLayer       底图（M2）
  RoomsLayer          房间填充色 + 房间名 + 畳数标签
  WallsLayer          墙线(固定视觉宽度 100mm 的线段) + 门窗符号(门弧线/引き戸双线/窗三线)
  StructureLayer      柱(实心方块) + 梁(虚线描边矩形，半透明填充)
  FurnitureLayer      家具(圆角矩形+名称) + 选中 Transformer(旋转+等比手柄)
  AnnotationLayer     尺寸线(自动标墙长) + 文字标注，listening 仅在 select 工具时
  OverlayLayer        绘制中的预览(画墙橡皮筋线)、吸附指示点、碰撞高亮
```

- 每层一个 React 组件，从 store 读数据渲染，**声明式：store 是唯一事实源**。
- 工具交互逻辑放 `src/tools/`（每工具一个 handler 对象：onPointerDown/Move/Up），PlanCanvas 只做路由。新增工具=新增文件+注册，不改画布。

## 5. 几何与吸附（`src/utils/geometry.ts`）

纯函数、无状态、可单测：

- `snap(v, step)` / `snapPt(p, step)`
- `pointSegProjection(p, a, b)`：点到线段投影（门窗沿墙滑动、选墙用）
- `wallDir/wallLen`
- 画墙时的**正交约束**：默认锁 0/90°（按住 Shift 解锁自由角度）
- `rotatedRectCorners(center, w, d, deg)` + `polysIntersectSAT(a, b)`：家具碰撞（家具 vs 家具、家具 vs 墙线段），碰撞只做**红色高亮提示**，不阻止放置
- 房间面积：鞋带公式 `polygonAreaMm2`

## 6. 持久化与导出（`src/utils/persist.ts`）

- 自动保存：planStore subscribe → debounce 800ms → `localStorage['house-planner:doc']`；启动时若存在则恢复（zod 校验失败则丢弃并提示）。
- JSON 导出/导入：下载 `.json` / `<input type=file>` 读入，导入前 zod 校验。
- PNG 导出：`stage.toDataURL({ pixelRatio: 按内容包围盒算 })`，导出前临时隐藏 Grid/Overlay 层。

## 7. UI 布局（`src/components/`）

```
App.tsx        左 Toolbar(竖条图标) + 中 PlanCanvas + 右 Sidebar + 底 StatusBar
Toolbar        工具切换（快捷键：V选择 W墙 D门 N窗 C柱 B梁 F家具 Esc回选择）＋ undo/redo ＋ 导入/导出/PNG
Sidebar        上：家具库(分类+搜索+点击进入放置模式+自定义尺寸表单)；下：选中元素属性面板(坐标/尺寸/旋转/颜色/删除)
StatusBar      指针 mm 坐标、缩放百分比、吸附步长切换、单位切换(畳/公制)、自动保存状态
```

- 视觉基调：浅色、大量留白、单一强调色（#4A6FA5 靛蓝系）、圆角小、无重投影；界面语言**中文**（文案集中在 `src/ui/strings.ts`，为将来日语化留位）。
- 不引 UI 组件库，普通 CSS（CSS Modules 或单 index.css 均可）——控件很少，避免依赖。

## 8. Milestone 对应实现顺序

1. **M1a 基建**：脚手架、model/schema、两个 store、PlanCanvas+Grid、缩放平移、App 布局壳
2. **M1b 墙与开口**：画墙工具、选择/删除、门窗放置与沿墙滑动、自动尺寸标注
3. **M1c 结构与家具**：柱/梁工具、家具库+放置+Transformer+碰撞高亮、属性面板
4. **M1d 收尾**：房间(手动多边形或墙围合推导，实现者选简单可靠的)、undo/redo 接线、持久化、PNG/JSON 导出、快捷键
5. ✅ **M2 底图**：上传（Toolbar 按钮 / 拖入画布）→ `utils/underlayImage.ts` 用 canvas 降采样到长边 ≤1600px 的 JPEG dataURL（PNG 透明区垫白底），超 1.5MB 就按「降质量→降尺寸」阶梯继续压，保证 localStorage 不爆；默认让图宽 ≈9100mm、居中、opacity 0.5、locked。比例标定是新工具 `underlay_calibrate`（取 `ctx.pt` 不吸附网格）：两点 + 实际长度 mm → 重算 `mmPerPixel` 并围绕两点中点保持位置（`offset₁ = M - k·(M - offset₀)`，与 rotation 无关），确认后自动回 select。底图坐标约定 `doc = offset + R(rotation)·(mmPerPixel·img_px)`（offset = 图片左上角），改角度/比例时用 `offsetKeepingCenter` 保持图心不动。锁定时 `listening=false` 完全不挡描图，解锁且在 select 工具下可拖动/点选（Konva id `underlay`）。控制面板 `components/UnderlayPanel.tsx`（有底图时常驻侧栏，选中底图时移进属性面板）。PNG 导出默认**不含**底图，勾选后底图才参与包围盒与渲染；localStorage 配额写满时 toast 明确提示而不是静默丢文档。
6. ✅ **M3 AI 识别**：`server/dev.mjs`（node:http，8787，仅 `POST /api/recognize`）+ 框架无关的 `server/recognize.mjs`
   （`@anthropic-ai/sdk` 的 `messages.parse()` + `zodOutputFormat`，模型 `claude-opus-5`，key 只在服务端）；
   prompt 集中在 `server/prompt.mjs`；`MOCK_RECOGNIZE=1`（或 `npm run dev:api:mock`）返回 `server/fixtures/mock-2ldk.json`，
   无 key 也能跑通全链路。schema 单一来源 `src/ai/recognizeSchema.ts`（归一化 0–1000 坐标，不要 mm 绝对值），
   纯函数求解器 `src/ai/solve.ts`（比例估计→正交化→共边归并+455 吸附→墙提取→洞口投影→柱转换→底图对齐，全程收集 warnings），
   UI 在 `components/RecognizeDialog.tsx`：整篇替换（非空文档要确认）→ `clearHistory` + `requestFit` + 柱全选高亮。
   详见 docs/AI-RECOGNITION.md。

## 9. 质量要求

- `npm run build`（tsc + vite build）零错误零警告通过后才算完成。
- geometry.ts / units.ts 配 vitest 单测（其余可不测）。
- 不引入规格之外的运行时依赖；确需引入时在汇报中说明理由。
