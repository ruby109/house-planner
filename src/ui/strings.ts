/**
 * 界面文案集中处（为将来日语化留位）。
 * 组件里不写死中文，全部经这里取。
 */
export const strings = {
  appName: 'house-planner',
  appSubtitle: '户型模拟器',

  tools: {
    select: '选择',
    wall: '画墙',
    door: '开き戸（门）',
    sliding_door: '引き戸（推拉门）',
    window: '窗',
    column: '柱',
    beam: '梁',
    furniture_place: '放置家具',
  },

  toolShortcuts: {
    select: 'V',
    wall: 'W',
    door: 'D',
    sliding_door: 'S',
    window: 'N',
    column: 'C',
    beam: 'B',
    furniture_place: 'F',
  },

  actions: {
    undo: '撤销',
    redo: '重做',
    importJson: '导入 JSON',
    exportJson: '导出 JSON',
    exportPng: '导出 PNG',
    fitView: '适应视图',
    comingSoon: '后续里程碑实现',
  },

  actionShortcuts: {
    undo: 'Ctrl+Z',
    redo: 'Ctrl+Shift+Z',
  },

  /** M1d：房间、导入导出、快捷键相关提示 */
  m1d: {
    docNameEdit: '点击重命名',
    roomDefaultName: '房间',
    roomCreateHint: '双击墙体围合的封闭区域可生成房间',
    roomNotFound: '这里没有被墙完全围合，无法生成房间',
    roomExists: '该区域已有房间',
    importInvalid: '文件不是有效的户型 JSON，已保持当前文档',
    importFailed: '文件读取失败',
    importDone: '已导入户型',
    exportEmpty: '文档为空，先画点东西再导出',
    exportPngFailed: 'PNG 导出失败',
    restoreInvalid: '本地存档已损坏，已从空文档开始',
    restoreDone: '已恢复上次编辑的文档',
    openingWidthInvalid: '该宽度放不下（超出墙长或与相邻开口重叠）',
  },

  /** M2：底图（上传 / 标定 / 控制） */
  m2: {
    title: '底图',
    upload: '底图',
    uploadTip: '上传間取り图照片作为底图描摹',
    uploadHint: '把間取り图照片拖进画布即可作为底图描摹',
    uploadDone: '底图已就位：先标定比例，再用画墙工具描图',
    uploadFailed: '图片读取失败，请换一张（支持 JPG / PNG / WebP）',
    notImage: '只支持图片文件',
    oversize: '图片压到最小档仍偏大，可能无法自动保存',
    replace: '更换图片',
    remove: '移除底图',
    opacity: '透明度',
    locked: '锁定（不可拖动，且不挡画布操作）',
    rotation: '旋转 °',
    scale: '比例',
    scaleUnit: 'mm/px',
    widthMm: '图宽',
    recalibrate: '重新标定',
    calibrateHint: '在底图上点击一段已知长度的两端（Esc 取消）',
    calibrateTitle: '这段的实际长度',
    calibrateConfirm: '确定',
    calibrateCancel: '取消',
    calibrateInvalid: '两点太近或长度非法，请重新标定',
    calibrateDone: (mmPerPixel: number) => `已标定：1px = ${mmPerPixel.toFixed(2)}mm`,
    calibrateNeedUnderlay: '先上传底图再标定',
    exportWithUnderlay: '导出 PNG 含底图',
    quotaExceeded: '底图过大，已跳过自动保存',
    unlockToEdit: '解锁后可拖动 / 旋转底图',
  },

  /** M3：AI 识别間取り图 */
  m3: {
    title: 'AI 识别間取り图',
    toolbar: 'AI 识别',
    toolbarTip: '上传間取り图，由 AI 识别成可编辑的户型',
    dropHint: '点击选择，或把間取り图拖到这里',
    dropFormats: '支持 JPG / PNG / WebP',
    replaceImage: '换一张',
    costNotice:
      '识别会把图片发送给下方显示的模型服务商，属于付费 API 调用（每张图数美分）。未配置 key 时可用 MOCK_RECOGNIZE=1 跑示例数据。',
    start: '开始识别',
    cancel: '取消',
    close: '关闭',
    notImage: '只支持图片文件',
    compressFailed: '图片读取失败，请换一张（支持 JPG / PNG / WebP）',
    phaseRecognize: '正在识别間取り图（通常 20~60 秒）…',
    phaseRecognizeRefine: '正在识别并二次校对間取り图（通常 1~2 分钟）…',
    phaseSolve: '正在求解几何约束…',
    refineLabel: '二次校对（更准，耗时翻倍）',
    /** M5：管线固定为「轮廓提取 + AI 标注」，UI 不再给选项 */
    pipelineHint:
      '墙体、房间轮廓与门窗洞口全部由本地图像处理从图上量出来，AI 只负责认房间名与帖数。图纸越清晰效果越好；整版广告图请先裁剪出户型部分。',
    phaseCv: '正在提取图纸轮廓…',
    phaseLabel: '正在识别房间名与帖数（通常 10~30 秒）…',
    /** 完成面板里的一行 CV 统计 */
    cvStats: (walls: number, rooms: number, mmPerPixel: number | null) =>
      `轮廓提取：${walls} 墙段 / ${rooms} 房间` +
      (mmPerPixel ? ` · 比例 ${mmPerPixel.toFixed(2)} mm/px` : ''),
    /** M5：洞口 / 柱的提取统计 */
    cvExtras: (openings: number, columns: number) =>
      `门窗洞口 ${openings} 处 / 柱 ${columns} 根（由轮廓提取推断，请逐个核对类型）`,
    cvFallback: '本次已回退纯 AI 模式（图纸轮廓提取不达标）',
    /** M4.2：完成面板里的一行「忽略了几个小隔间」 */
    smallRoomsIgnored: (n: number) =>
      `已忽略 ${n} 个小隔间（洗面所・トイレ等），需要时请用画墙工具手动补画`,
    /** M5：CV 不达标时的引导 */
    cvInsufficientTitle: '这张图没法自动提取户型',
    cvInsufficientHint:
      '可以换一张更清晰、只含户型部分的图再试；也可以直接把这张图设为底图，用画墙工具手动描摹。',
    useAsUnderlay: '把这张图设为底图并手动描摹',
    failedTitle: '识别失败',
    retry: '重试',
    replaceTitle: '替换当前文档？',
    replaceBody: '识别结果会清空当前文档（包括已画的墙、家具与底图），且这一步不可撤销。',
    replaceConfirm: '替换',
    applyDone: (rooms: number, walls: number, columns: number) =>
      `识别完成：${rooms} 房间 / ${walls} 墙 / ${columns} 柱。如需标注梁，请用画梁工具手动添加`,
    doneTitle: '识别完成',
    columnsHint: '柱与「面积和帖数标注对不上」的房间已选中，请逐个确认；梁需要手动补画。',
    warningsTitle: '以下内容需要人工确认：',
    modelLabel: '模型',
    providerInfo: (provider: string, model: string) => `识别服务：${provider} · ${model}`,
    mockInfo: '识别服务：mock 模式（返回示例数据，不会真的调用 API）',
  },

  sidebar: {
    catalogTitle: '家具库',
    searchPlaceholder: '搜索家具（中/日文）',
    empty: '没有匹配的家具',
    propertiesTitle: '属性',
    noSelection: '未选中任何元素',
    placeHint: '家具放置将在 M1c 里程碑开放',
    sizeUnit: 'mm',
  },

  statusBar: {
    pointer: '指针',
    zoom: '缩放',
    snap: '吸附',
    snapOn: '开',
    snapOff: '关',
    unit: '单位',
    unitJa: '畳',
    unitMetric: '公制',
    autosave: '自动保存',
    autosaveOff: '未启用',
    autosaveIdle: '待保存',
    autosaveSaving: '保存中…',
    /** 已保存 HH:MM */
    autosaveSaved: (hhmm: string) => `已保存 ${hhmm}`,
    autosaveError: '保存失败',
  },

  canvas: {
    panHint: '空格 / 中键拖拽平移　滚轮缩放',
  },
} as const;
