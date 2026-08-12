import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { Layer, Stage } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Stage as KonvaStage } from 'konva/lib/Stage';
import {
  BASE_SCALE,
  FIT_PADDING_MM,
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_FACTOR,
} from '../../model/defaults';
import { clamp, snapPt } from '../../utils/geometry';
import { docBounds } from '../../utils/docBounds';
import { registerStage } from '../../utils/exportPng';
import { cachedImageSize } from '../../utils/underlayImage';
import { loadUnderlayFromFile, pickImageFile } from '../../utils/underlayUpload';
import type { Pt } from '../../model/types';
import { usePlanStore } from '../../store/planStore';
import { useUiStore } from '../../store/uiStore';
import { strings } from '../../ui/strings';
import { activeToolHandler, cancelTool } from '../../tools/registry';
import type { ToolContext } from '../../tools/types';
import { GridLayer, type ViewTransform } from './GridLayer';
import { UnderlayLayer } from './UnderlayLayer';
import { RoomsLayer } from './RoomsLayer';
import { WallsLayer } from './WallsLayer';
import { StructureLayer } from './StructureLayer';
import { FurnitureLayer } from './FurnitureLayer';
import { AnnotationLayer } from './AnnotationLayer';
import { OverlayLayer } from './OverlayLayer';

const INITIAL_VIEW: ViewTransform = { scale: BASE_SCALE, x: 0, y: 0 };

/** 文档为空时 fit 到的默认可视范围（mm） */
const EMPTY_EXTENT_MM = 9100;

export function PlanCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<KonvaStage | null>(null);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ViewTransform>(INITIAL_VIEW);
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);

  const setPointer = useUiStore((s) => s.setPointer);
  const setScale = useUiStore((s) => s.setScale);
  const fitToken = useUiStore((s) => s.fitToken);

  // 用 ref 保存拖拽起点，避免拖动过程中反复重建回调
  const panOrigin = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);

  // ---------------------------------------------------------------- 尺寸自适应
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      setSize({ width: Math.max(0, Math.floor(r.width)), height: Math.max(0, Math.floor(r.height)) });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, []);

  // ---------------------------------------------------------------- 适应视图
  const fitView = useCallback(() => {
    const { width, height } = size;
    if (width <= 0 || height <= 0) return;

    // 底图也算进「适应视图」的范围：刚上传、还没描墙时也能框住整张图
    const doc = usePlanStore.getState().doc;
    const b = docBounds(
      doc,
      FIT_PADDING_MM,
      doc.underlay ? cachedImageSize(doc.underlay.imageDataUrl) : null,
    );
    const minX = b ? b.minX : -EMPTY_EXTENT_MM / 2;
    const minY = b ? b.minY : -EMPTY_EXTENT_MM / 2;
    const maxX = b ? b.maxX : EMPTY_EXTENT_MM / 2;
    const maxY = b ? b.maxY : EMPTY_EXTENT_MM / 2;

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = clamp(Math.min(width / spanX, height / spanY), MIN_SCALE, MAX_SCALE);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    setView({ scale, x: width / 2 - cx * scale, y: height / 2 - cy * scale });
  }, [size]);

  // 首次拿到尺寸后自动 fit 一次
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (didInitialFit.current) return;
    if (size.width > 0 && size.height > 0) {
      didInitialFit.current = true;
      fitView();
    }
  }, [size, fitView]);

  // 响应 uiStore 的 fit 请求（跳过初始值 0）
  const lastFitToken = useRef(fitToken);
  useEffect(() => {
    if (fitToken === lastFitToken.current) return;
    lastFitToken.current = fitToken;
    fitView();
  }, [fitToken, fitView]);

  // ---------------------------------------------------------------- 回写缩放
  useEffect(() => {
    setScale(view.scale);
  }, [view.scale, setScale]);

  // ---------------------------------------------------------------- 空格平移
  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return;
      e.preventDefault();
      setSpaceDown(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      setSpaceDown(false);
    };
    const onBlur = () => setSpaceDown(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // ---------------------------------------------------------------- 平移（中键 / 空格 + 左键）
  const beginPan = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const isMiddle = e.button === 1;
      const isSpaceLeft = e.button === 0 && spaceDown;
      if (!isMiddle && !isSpaceLeft) return;
      e.preventDefault();
      panOrigin.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
      setPanning(true);
    },
    [spaceDown, view.x, view.y],
  );

  useEffect(() => {
    if (!panning) return;
    const onMove = (e: MouseEvent) => {
      const o = panOrigin.current;
      if (!o) return;
      setView((v) => ({ ...v, x: o.vx + (e.clientX - o.px), y: o.vy + (e.clientY - o.py) }));
    };
    const onUp = () => {
      panOrigin.current = null;
      setPanning(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [panning]);

  // ---------------------------------------------------------------- 滚轮缩放（以指针为中心）
  const handleWheel = useCallback((e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const p = stage.getPointerPosition();
    if (!p) return;

    setView((v) => {
      const worldX = (p.x - v.x) / v.scale;
      const worldY = (p.y - v.y) / v.scale;
      const zoomIn = e.evt.deltaY < 0;
      const next = clamp(
        zoomIn ? v.scale * ZOOM_FACTOR : v.scale / ZOOM_FACTOR,
        MIN_SCALE,
        MAX_SCALE,
      );
      if (next === v.scale) return v;
      return { scale: next, x: p.x - worldX * next, y: p.y - worldY * next };
    });
  }, []);

  // ---------------------------------------------------------------- 工具事件路由
  const activeTool = useUiStore((s) => s.activeTool);

  // 切换工具时取消上一个工具的绘制中间态
  const prevTool = useRef(activeTool);
  useEffect(() => {
    if (prevTool.current !== activeTool) {
      cancelTool(prevTool.current);
      prevTool.current = activeTool;
    }
  }, [activeTool]);

  // Esc 取消当前工具的绘制中间态（Esc 回选择工具在 M1d 快捷键统一处理）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      cancelTool(useUiStore.getState().activeTool);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** 从 Konva 事件构造 ToolContext；指针不在 Stage 上时返回 null */
  const buildToolCtx = useCallback(
    (e: KonvaEventObject<MouseEvent>): ToolContext | null => {
      const stage = stageRef.current;
      if (!stage) return null;
      const p = stage.getPointerPosition();
      if (!p) return null;
      const pt: Pt = {
        x: Math.round((p.x - view.x) / view.scale),
        y: Math.round((p.y - view.y) / view.scale),
      };
      const step = useUiStore.getState().effectiveSnapStep();
      const rawId = e.target === stage ? '' : e.target.id();
      return {
        pt,
        snapped: snapPt(pt, step),
        shiftKey: e.evt.shiftKey,
        altKey: e.evt.altKey,
        ctrlKey: e.evt.ctrlKey,
        targetId: rawId === '' ? null : rawId,
      };
    },
    [view.x, view.y, view.scale],
  );

  const handleStageMouseDown = useCallback(
    (e: KonvaEventObject<MouseEvent>) => {
      // 平移手势（中键 / 空格+左键）不路由给工具；右键 = 取消绘制中间态
      if (panning || spaceDown) return;
      if (e.evt.button === 2) {
        cancelTool(useUiStore.getState().activeTool);
        return;
      }
      if (e.evt.button !== 0) return;
      const ctx = buildToolCtx(e);
      if (ctx) activeToolHandler().onPointerDown?.(ctx);
    },
    [panning, spaceDown, buildToolCtx],
  );

  /** 双击：M1d 起 select 工具用它把封闭区域变成房间 */
  const handleStageDblClick = useCallback(
    (e: KonvaEventObject<MouseEvent>) => {
      if (panning || spaceDown || e.evt.button !== 0) return;
      const ctx = buildToolCtx(e);
      if (ctx) activeToolHandler().onDoubleClick?.(ctx);
    },
    [panning, spaceDown, buildToolCtx],
  );

  const handleStageMouseUp = useCallback(
    (e: KonvaEventObject<MouseEvent>) => {
      if (panning || spaceDown || e.evt.button !== 0) return;
      const ctx = buildToolCtx(e);
      if (ctx) activeToolHandler().onPointerUp?.(ctx);
    },
    [panning, spaceDown, buildToolCtx],
  );

  // ---------------------------------------------------------------- 指针 mm 坐标
  const handleMouseMove = useCallback(
    (e: KonvaEventObject<MouseEvent>) => {
      const stage = stageRef.current;
      if (!stage) return;
      const p = stage.getPointerPosition();
      if (!p) return;
      setPointer({
        x: Math.round((p.x - view.x) / view.scale),
        y: Math.round((p.y - view.y) / view.scale),
      });
      if (!panning && !spaceDown) {
        const ctx = buildToolCtx(e);
        if (ctx) activeToolHandler().onPointerMove?.(ctx);
      }
    },
    [view.x, view.y, view.scale, setPointer, panning, spaceDown, buildToolCtx],
  );

  const handleMouseLeave = useCallback(() => setPointer(null), [setPointer]);

  /**
   * PNG 导出需要拿到 Stage。
   * 必须用回调 ref 而不是 useEffect：StrictMode 下组件会挂载两次，
   * 用 effect 登记有可能把「已被销毁的那一个 Stage」留在模块变量里，
   * 导出时就会画到一张空图上。回调 ref 由 React 保证 null/新节点成对调用。
   */
  const attachStage = useCallback((node: KonvaStage | null) => {
    stageRef.current = node;
    registerStage(node);
  }, []);

  // ---------------------------------------------------------------- 底图拖放（M2）
  const [dropping, setDropping] = useState(false);

  const handleDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  }, []);

  const handleDragLeave = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    // 只有真正离开容器（而不是掠过子元素）才收起高亮
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropping(false);
  }, []);

  const handleDrop = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropping(false);
    const file = pickImageFile(e.dataTransfer);
    if (file) void loadUnderlayFromFile(file);
  }, []);

  // ---------------------------------------------------------------- 提示文案
  const isEmptyDoc = usePlanStore(
    (s) =>
      s.doc.underlay === null &&
      s.doc.walls.length === 0 &&
      s.doc.rooms.length === 0 &&
      s.doc.structures.length === 0 &&
      s.doc.furniture.length === 0,
  );

  const cursor = panning ? 'grabbing' : spaceDown ? 'grab' : 'default';

  return (
    <div
      ref={containerRef}
      className={`canvas-host${dropping ? ' is-dropping' : ''}`}
      style={{ cursor }}
      onMouseDown={beginPan}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {size.width > 0 && size.height > 0 && (
        <Stage
          ref={attachStage}
          width={size.width}
          height={size.height}
          scaleX={view.scale}
          scaleY={view.scale}
          x={view.x}
          y={view.y}
          onWheel={handleWheel}
          onMouseDown={handleStageMouseDown}
          onMouseUp={handleStageMouseUp}
          onDblClick={handleStageDblClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {/*
            Konva 建议 Stage 层数 ≤5，这里把 8 个逻辑层合并成 5 个 Layer。
            渲染顺序保持不变：grid < underlay < rooms < walls < structures <
            furniture < annotations < overlay —— 各逻辑层现在是 Group。
          */}
          <Layer>
            <GridLayer view={view} width={size.width} height={size.height} />
            <UnderlayLayer />
          </Layer>
          <Layer>
            <RoomsLayer />
            <WallsLayer />
          </Layer>
          <Layer>
            <StructureLayer />
            <FurnitureLayer />
          </Layer>
          <Layer>
            <AnnotationLayer />
          </Layer>
          <OverlayLayer />
        </Stage>
      )}
      <div className="canvas-hint">
        {activeTool === 'underlay_calibrate'
          ? strings.m2.calibrateHint
          : `${strings.canvas.panHint}${
              activeTool === 'select' ? `　${strings.m1d.roomCreateHint}` : ''
            }${isEmptyDoc ? `　${strings.m2.uploadHint}` : ''}`}
      </div>
    </div>
  );
}

export default PlanCanvas;
