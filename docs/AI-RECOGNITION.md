# M3 AI 识别 —— 设计规格

> 目标：上传間取り图 → Claude 视觉识别 → 几何约束求解 → 生成可编辑 PlanDoc（墙/门窗/柱/房间）并把原图设为对齐的底图。
> 本文档是 M3 的实现契约；API 用法遵循 Anthropic 官方 TS SDK。

## 1. 架构

```
前端 RecognizeDialog ──(压缩后 JPEG dataURL + 图片像素尺寸)──▶ POST /api/recognize
                                                              │  server/recognize.ts（框架无关 handler）
                                                              │  · @anthropic-ai/sdk，ANTHROPIC_API_KEY 来自 .env
                                                              │  · client.messages.parse + zodOutputFormat(RecognizeResultSchema)
                                                              ▼
                                    RecognizeResult（语义+归一化坐标 JSON）
                                                              │
前端 solver（纯函数 src/ai/solve.ts）：比例估计→正交化→共边归并→墙提取→门窗投影→柱转换
                                                              ▼
                    Partial<PlanDoc>（walls/openings/structures/rooms）+ 对齐好的 underlay
```

- **本地开发**：`server/dev.mjs` 用 `node:http` 起在 8787（无框架，代码 ≤100 行），`vite.config.ts` 加 `server.proxy: {'/api': 'http://localhost:8787'}`。handler 逻辑放在框架无关的 `server/recognize.ts`（一个 `(body) => Promise<result>` 函数），将来部署 Vercel 时直接包一层即可。
- **key 管理**：`.env`（**加入 .gitignore**）存 `ANTHROPIC_API_KEY`；提交 `.env.example`。前端永远不接触 key。
- **模型**：`claude-opus-5`（默认，可用 env `RECOGNIZE_MODEL` 覆盖）。thinking 默认开启（omit thinking 参数即可）；`max_tokens: 16000`；用 `client.messages.parse()` + `output_config.format`。
- **图片**：前端复用 `utils/underlayImage.ts` 的压缩（长边 ≤1600px JPEG）后发送 base64；请求体里同时带 `imageWidthPx/imageHeightPx`。
- **错误处理**：SDK typed exceptions（`RateLimitError`→提示稍后再试；`AuthenticationError`→提示配 key）；`stop_reason === 'refusal'` 一并按「识别失败请重试」处理。**服务端不重试超过 1 次**（zod 校验失败时把校验错误摘要作为追加 user turn 重试一次）。

> **实现说明（M3 落地时的取舍）**：server 端文件用 `.mjs` + JSDoc（`server/recognize.mjs`、`server/prompt.mjs`、`server/dev.mjs`），
> 不进 tsc / vite，`node server/dev.mjs` 直接可跑；zod schema 仍然只有 **一份**，放在 `src/ai/recognizeSchema.ts`，
> server 端靠 Node 24 的原生类型剥离直接 `import '../src/ai/recognizeSchema.ts'`，前端照常 import ——
> 既避免了两份 schema 漂移，也不用引入 tsx 之类的额外运行时。
> 另外 `zodOutputFormat()` 只接受 **zod v4** 的 schema，所以 `recognizeSchema.ts` 用 `zod/v4` 子路径，
> 与项目其余部分（`model/schema.ts`，zod v3）共存。

## 2. AI 输出 Schema（`src/ai/recognizeSchema.ts`，zod）

原则：**语义 + 归一化坐标（0–1000，相对图片，x 右 y 下），不要毫米绝对坐标**——VLM 的精确坐标不可靠，靠 solver 换算与规整。schema 必须满足 structured outputs 限制：所有 object `additionalProperties: false`（zod `.strict()`）、**不用** min/max 数值约束、不用递归。

> **坐标系有两套，别搞混**（2026-08-11 竖长条图识别失败后确定）：
> - **模型侧**：`x = 像素x ÷ 图宽 × 1000`、`y = 像素y ÷ 图高 × 1000`，**两轴各自独立**，都恒在 0–1000。
>   公式原文在 `src/ai/recognizeShared.ts` 的 `NORM_COORD_RULE`（prompt 与校验失败重试文案共用同一份）。
> - **内部**（`solve.ts` / `fuse.ts`）：两轴**同一比例尺**，都按图宽归一化，所以竖图的 y 会大于 1000。
>
> 两者由 `applyImageAspect()` 换算（`y内部 = y模型 × 图高 ÷ 图宽`），换算点在 `server/recognize.mjs`，
> **在校验与 sanitize 之后**。校验的 0–1000 只针对模型侧。
>
> 另有一道兜底 `fixAxisNormalization()`：模型在长宽比悬殊的图上会本能地做**等比归一化**
> （两轴共用比例尺 → 竖图 y 冲到 1100~2100）。这是纯单轴线性缩放、信息无损，所以某轴最大值
> 落在 (1000, 2600] 时直接 `× 1000/最大值` 压回并记一条 warning，不再浪费一次重试；
> 超过 2600（多半是像素坐标）或负数越界仍照旧报校验错误。

```ts
RecognizeResult = {
  notes: string,                       // 模型对图的自由观察（调试用，不进文档）
  scale: {
    method: 'tatami' | 'dimension_text' | 'estimate',
    drawingWidthMm: number,            // 模型估计的图内建筑总宽（配合 method 供 solver 兜底）
  },
  rooms: Array<{
    id: string,                        // "r1", "r2"…
    name: string,                      // LDK / 洋室 / 和室 / 浴室 / 玄関…（保留日文）
    floor: 'flooring' | 'tatami' | 'tile' | 'other',
    tatamiCount: number | null,        // 图上标注的帖数（6帖→6；标 ㎡ 则换算 1帖=1.62㎡；没有→null）
    polygon: Array<{ x: number, y: number }>,  // 归一化 0–1000，多边形（顶点 4~14 个，斜边如实保留），按序闭合（不重复首点）
  }>,
  openings: Array<{
    type: 'door' | 'sliding_door' | 'window' | 'opening',
    roomA: string,                     // 房间 id；室外用 "outside"
    roomB: string,
    x: number, y: number,              // 洞口中心归一化坐标
  }>,
  columns: Array<{
    x: number, y: number,              // 柱中心归一化坐标
    w: number | null, h: number | null // 柱在图上的归一化宽高（可为 null，solver 给默认）
  }>,
}
```

## 3. Prompt 要点（`server/prompt.ts`，集中一个文件）

系统提示内嵌日本間取り図领域知识，要求：

1. 身份：日本建筑图纸识别专家；输出严格按 schema。
2. 凡例知识：帖/畳（1帖≈1.62㎡）、910mm 尺模数、LDK/DK/K 含义、玄関/押入/クローゼット/バルコニー、引き戸 vs 开き戸符号（弧线=开き戸、双错线=引き戸）、窗=墙上三线/双线、柱=实心或空心小方块、マンション图中墙角凸出的柱型。
3. 房间 polygon 规则：沿墙中心线取多边形（接近水平/垂直的边画成直角，**真实的斜め壁 / 角の斜めカット 按实际角度如实描**）；相邻房间的共享边坐标应一致；整体外轮廓闭合；画完自检面积与帖数标注成正比。
4. **不识别梁**（明确告知忽略虚线天花板构件）。
5. 柱：只标注确信的（实心方块/柱型凸角），宁缺勿滥。
6. scale：优先用帖数标注（method=tatami）；图上有尺寸文字（mm）时 method=dimension_text 并按其估 drawingWidthMm；都没有按常识估计（method=estimate）。
7. 附一段 few-shot 风格的输出说明（不是完整例子，是字段填写示范片段），控制 prompt 总长。

## 4. 几何求解器（`src/ai/solve.ts` + `solve.test.ts`，纯函数，重点单测）

输入 `RecognizeResult` + 图片像素尺寸 → 输出 `{ doc: Pick<PlanDoc,'walls'|'openings'|'structures'|'rooms'>, underlayTransform: {mmPerPixel, offset} }`。

管线（每步一个导出函数，便于单测）：

1. **estimateScale**：`k` = mm / 归一化单位。有 tatamiCount 的房间：`k = sqrt(Σ(tatami×1.6562e6 mm²) / Σ(polygon 归一化面积))`；无 → `k = drawingWidthMm / 1000`。
2. **regularizePolygon**（M3.1 前叫 rectilinearize）：与 0°/90° 偏差 ≤10° 的边轴对齐（取端点均值），**其余保留为斜边**；顶点转 mm（×k），共线相邻点合并。见 6.6 节。
3. **snapSharedEdges**：跨房间聚类相近的**轴对齐**坐标（容差 300mm）→ 归并为同一值（保证相邻房间共墙共线）；然后整体吸附 455 网格；斜边端点改走插值 + 100mm 吸附；平移使最小角落在 (0,0)。
4. **deriveWalls**：轴向边按轴向分组、重叠/相接共线段合并去重；斜边按「角度 + 法向偏移」分组后同样合并 → 输出 Wall[]。
5. **placeOpenings**：洞口点×k→mm，投影到 roomA/roomB 共享墙段（找不到共享墙则投影全局最近墙，距离 >1200mm 丢弃并记 warning）；默认宽度 door 780 / sliding_door 1690 / window 1690 / opening 910，clamp 进墙段、与已放置洞口避让（复用 `tools/wallGeometry.ts` 的 clamp/冲突函数）。
6. **convertColumns**：×k、吸附 100mm；w/h 为 null 时默认 105×105，否则 ×k 后取整。
7. **buildRooms**：规整后的多边形直接作为 Room（name/floor 沿用；id 换 `r_` 前缀 nanoid），并做帖数一致性校验（见 6.6 节）。
8. **alignUnderlay**：`mmPerPixel = k × 1000 / imageWidthPx`；offset = 步骤 3 的平移量反推，保证底图与生成的平面图对齐叠放。
9. 全程收集 `warnings: string[]`（丢弃的洞口、没有帖数只能估比例等），随结果返回给 UI 展示。

单测：构造 2~3 个合成 RecognizeResult fixture（含歪斜坐标、共享边不齐、帖数比例），断言：墙全部正交、端点在 455 网格、相邻房间共墙、面积误差 <10%、洞口落在墙上。

## 5. 前端流程（`src/components/RecognizeDialog.tsx` + `src/ai/recognizeClient.ts`）

1. Toolbar 加「AI 识别」按钮 → 对话框：选择/拖入图片（复用压缩）→ 显示缩略图 + 提示文案（含「识别为付费 API 调用」说明）→ 开始。
2. 调 `/api/recognize`，进行中显示 spinner + 阶段文案；失败 toast 具体原因。
3. 成功：当前文档非空时确认「替换当前文档？」（取消则中止；不做合并模式）。
4. 应用：清空文档 → 写入 solver 结果 + underlay（原图，opacity 0.4，locked）→ `clearHistory` + `requestFit` → toast「识别完成：N 房间 / N 墙 / N 柱。如需标注梁，请用画梁工具手动添加」＋ warnings 列表（server 侧 warnings 排在 solver warnings 之前）。
5. 柱 + 面积与帖数标注对不上的房间以选中态高亮，提示用户逐个确认（id 全部放进 selection）。
6. 对话框里的「二次校对（更准，耗时翻倍）」勾选框（默认开）→ 请求体的 `refine`（见 6.6 节）。

## 6. Mock 模式（无 key 可开发/测试）

`MOCK_RECOGNIZE=1` 时 server 不调 API，延迟 800ms 返回 `server/fixtures/mock-2ldk.json`（一份手工构造的合理 RecognizeResult）。浏览器 E2E 用 mock 跑通全链路。`.env.example` 里写明两个变量。

## 6.5 OpenRouter provider（M3+ 追加）

为了横向对比多家视觉模型，识别路径抽了一层 provider：

```
server/recognize.mjs          provider 选择 + 入参校验（model allowlist）
├── providers/openrouter.mjs  fetch → POST /api/v1/chat/completions
├── providers/anthropic.mjs   原来的 @anthropic-ai/sdk 路径（逻辑不变）
└── retry.mjs                 两条路径共用的「校验失败追加 user turn 重试一次」
```

- **provider 选择**：env `RECOGNIZE_PROVIDER`（`openrouter` | `anthropic`）优先；
  没设时「有 `OPENROUTER_APIKEY` 且没有 `ANTHROPIC_API_KEY` → openrouter」，否则 anthropic。
- **消息格式**：OpenAI 风格，`content: [{type:'image_url', image_url:{url:<完整 dataURL>}}, {type:'text', …}]`，
  system 沿用 `prompt.mjs` 的同一份领域知识（`buildUserText()` 是 provider 无关的文本部分）。
- **结构化输出**：`response_format: {type:'json_schema', json_schema:{name:'recognize_result', strict:true, schema}}`。
  schema 由 zod v4 的 `z.toJSONSchema()` 生成（`src/ai/recognizeShared.ts` 的 `toStrictJsonSchema()`：
  去掉 `$schema`，并递归保证每个 object 都 `additionalProperties:false` + `required` 列全）。
- **降级路径**：模型/网关对 `response_format` 报 400/404/422 且错误信息里提到 `response_format` /
  `json_schema` / `structured output` 时，自动去掉 `response_format` 重发，靠 prompt 里追加的
  「只输出一个 JSON 对象」约束（`JSON_ONLY_SUFFIX` + 内联 schema），回复用 `parseModelJson()`
  剥掉 markdown 围栏后解析。降级状态在本次请求内粘住（重试那一轮也不再带 schema）。
- **请求体 `model`**：可选，只接受 env `RECOGNIZE_MODELS`（逗号分隔 allowlist，默认三个对比模型）
  里的值，非法 → 400。对话框底部的下拉与批量测试脚本都走这个字段。
- **usage**：请求里带 `usage: {include: true}`，响应的 `usage.cost` 直接透传，
  返回 `{result, usage:{prompt_tokens, completion_tokens, total_tokens, total_cost, calls}, model, ms, …}`。
- `GET /api/recognize/info` → `{provider, model, models, mock}`，对话框底部显示一行小字 + 模型下拉。

### 批量对比脚本

```bash
node --env-file=.env server/test-recognize.mjs [--models a,b,c] [--dir testdata] [--out testdata/results] [--only test2.jpg] [--refine]
```

逐图 × 逐模型串行调用（直接 import handler，不走 HTTP），失败不中断整批；
每个组合写一份 JSON（识别结果 + solver 摘要 + usage/耗时），最后生成 `summary.md` 对比表。
测试图放 `testdata/`（见该目录的 README；>3MB 的图会被跳过）。

> `server/tsHooks.mjs`：脚本要 import `src/ai/solve.ts`，而它内部用的是省略扩展名的相对 import，
> 所以用 Node 内置的 `module.registerHooks()` 补一个 resolve hook（不引入 tsx/ts-node）。

## 6.6 M3.1 识别质量修正（斜墙 / 面积校验 / 二次校对）

用 5 张真实間取り図横评之后发现两个**设计层面**的问题，M3.1 逐个修掉：

### ① 斜墙全链路（原来整条管线强制正交化）

原 prompt 要求「只出直角多边形」、solver 的 `rectilinearize` 把每条边掰成轴对齐，
于是塔楼户型的斜切角、洋室的斜边全被拉直（`testdata/test2.jpg` 最明显）。现在：

- **prompt**：明确「斜め壁・角の斜めカットは実在する，按实际角度如实描顶点，不要直角化」，
  同时保留「接近水平/垂直的边照直角画」的引导；顶点数上限放宽到 4~14，并加了一个带斜切角的示例。
- **`regularizePolygon`**（原 `rectilinearizePolygon`）：逐边算角度，与 0°/90° 偏差
  ≤ `ANGLE_SNAP_TOL_DEG`（10°）才轴对齐（并查集取均值，沿用原逻辑），
  否则保留为斜边——两端点在两个轴上都不参与归并，用 ×k 后的原始 mm 坐标。
- **`snapSharedEdges`**：只把**轴对齐边**的坐标喂给 `buildAxisMap`（斜边端点会污染墙线聚类）；
  斜边端点走 `snapDiagonalAxis()`：先 `applyAxis` 插值（跟随相邻正交几何），
  离某条正交墙线 < `DIAGONAL_SNAP_MM`（100mm）就直接落到那条线上（保证共享顶点严丝合缝），
  否则吸附 100mm 网格。**刻意不上 455 网格**——两端各拉一次会明显改变角度。
- **`deriveWalls`**：轴向墙逻辑不变；斜边按「角度（取整到 1°）+ 法向偏移（容差
  `DIAGONAL_OFFSET_TOL_MM`）」分组，组内沿直线方向做区间合并，
  相邻房间共享的斜边因此只出**一段**墙。
- **洞口**：`nearestWall` / `pointSegProjection` 本来就是任意角度的；
  只有「房间是否贴着这道墙」的判定原来写死了轴向，已补上斜墙分支。

### ② 帖数一致性校验

比例 `k` 是全局最小二乘出来的，所以「个别房间的面积与它自己的帖数标注对不上」
是一个可靠的错误信号（test2 的洋室(1) 真值 7.0 帖被认成 12.9 帖，之前完全没有兜底）。
`buildRooms()` 现在返回 `{rooms, mismatchedRoomIds, warnings}`：偏差 >
`AREA_MISMATCH_TOLERANCE`（25%）就报「房间「X」面积（Y帖）与标注（Z帖）偏差 N%，建议核对」，
`SolveResult.areaMismatchRoomIds` 交给 `applyRecognition()`，和柱一起进 selection 高亮，
文案也在对话框的完成面板里列出。

### ③ 二次校对 refine（可选，默认开）

请求体加 `refine?: boolean`。为 true 时在首次识别成功后追加一轮：
`assistant(上轮 JSON)` + `user(REFINE_USER_TEXT)`，仍带图片与结构化输出，
让模型对照图重点核对「①帖数与面积比例 ②斜墙/切角 ③房间相邻关系」并重出完整 JSON。
两条 provider 路径都实现了；**失败一律回退首轮结果并记 warning**（不让整次识别失败），
usage 两轮累加。UI 是对话框里的「二次校对（更准，耗时翻倍）」勾选框，
批量脚本是 `--refine`（另有 `--only a.jpg,b.jpg` 用于小样验证控制成本）。

> 效果（test2.jpg × qwen3.7-flash）：斜墙 0 段 → 2 段（130°/131°），
> 洋室(1) 12.9 帖（标注 7.0，+84%）→ 5.6 帖（−20%，不再报警）。

## 7. 验收

- `npm run build` 零错误；`npx vitest run` 全绿（solver 管线各步 + 端到端 fixture）。
- dev server + mock：完整走一遍 UI 流程，确认生成的户型正交、吸附、底图对齐、可继续编辑、undo 历史干净、刷新后恢复。
- 真实 API 调用留给用户配 key 后验证（汇报里写清楚配置步骤）。
