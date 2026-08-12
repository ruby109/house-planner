/**
 * 选中元素属性面板 —— M1c 起（Sidebar 下半部），M1d 补全房间与门窗。
 *
 * 按 selection[0] 的 id 前缀（w_/o_/s_/r_/f_）展示对应属性：
 * - 家具：名称 / 宽 / 深 / 旋转 / 颜色 / 锁定 / 位置 + 删除
 * - 柱梁：宽 / 深 / 旋转 / 位置 + 删除
 * - 房间（M1d）：名称 / 地面类型 / 面积（只读）+ 删除
 * - 门窗（M1d）：门可切四种 swing、可改洞口宽（非法则拒绝并保持原值）
 * - 墙：只读基本信息 + 删除
 *
 * 文案就近写在本文件（ui/strings.ts 由 M1a 维护，避免并行改动冲突）。
 */
import { useEffect, useRef, useState } from 'react';
import { UNDERLAY_ID, idPrefix } from '../model/defaults';
import type { Furniture, FloorType, Opening, OpeningSwing, Pt, Room, Structure, Wall } from '../model/types';
import { pauseHistory, resumeHistory, usePlanStore } from '../store/planStore';
import { useUiStore } from '../store/uiStore';
import { polygonAreaMm2, wallDir, wallLen } from '../utils/geometry';
import { formatAreaBoth, formatInt, formatMm } from '../utils/units';
import {
  clampOpeningOffset,
  hasOpeningConflict,
  openingFits,
} from '../tools/wallGeometry';
import { FLOOR_LABELS, FLOOR_ORDER } from '../ui/canvasStyle';
import { strings } from '../ui/strings';
import { notify } from '../ui/toast';
import { UnderlayPanel } from './UnderlayPanel';
import './panels.css';

const TEXT = {
  none: '未选中任何元素',
  multi: (n: number) => `已选中 ${n} 个元素`,
  missing: '选中的元素已不存在',
  remove: '删除',
  removeAll: '删除全部',
  kind: {
    wall: '墙',
    opening: '门窗',
    structure: '结构',
    furniture: '家具',
    room: '房间',
    annotation: '标注',
  },
  structureKind: { column: '柱', beam: '梁' } as Record<Structure['kind'], string>,
  openingType: {
    door: '开き戸（门）',
    sliding_door: '引き戸（推拉门）',
    window: '窗',
    opening: '开口',
  } as Record<Opening['type'], string>,
  name: '名称',
  width: '宽 mm',
  depth: '深 mm',
  rotation: '旋转 °',
  color: '颜色',
  locked: '锁定（不可拖动 / 变形）',
  posX: 'X mm',
  posY: 'Y mm',
  position: '位置',
  rotate90: '+90°',
  length: '长度',
  lengthMm: '长度 mm',
  start: '起点',
  end: '终点',
  startX: '起点 X',
  startY: '起点 Y',
  endX: '终点 X',
  endY: '终点 Y',
  wallLengthInvalid: '墙长至少 100 mm',
  offset: '距墙起点',
  wallId: '所属墙',
  openingWidth: '洞口宽 mm',
  hintReadonly: '也可以在画布上拖动端点手柄修改。',
  hintOpening: '洞口可在画布上沿墙拖动。',
  swing: '开启方向',
  swingLabels: {
    in_left: '内·左',
    in_right: '内·右',
    out_left: '外·左',
    out_right: '外·右',
  } as Record<OpeningSwing, string>,
  floor: '地面',
  area: '面积',
  vertices: '顶点数',
  roomHint: '双击封闭区域可生成房间；房间随墙改动不会自动更新。',
};

const SWING_ORDER: OpeningSwing[] = ['in_left', 'in_right', 'out_left', 'out_right'];

// ---------------------------------------------------------------------------
// 受控数字 / 文本输入
//
// NumberField 走「实时预览 + 一步撤销」：
// - 逐字输入时 pauseHistory()，合法值立刻写 store（画布实时跟随）但不进历史；
// - 失焦 / 回车：仍在暂停中先把 store 复位到编辑前的值（不留痕），
//   再 resumeHistory() 并写入最终值 —— 整段编辑恰好一条历史；
// - Esc：复位 + resume，不留历史；
// - 非法输入（空 / NaN / 越界 / validate 失败）实时阶段忽略，失焦时回退原值；
// - 组件卸载（切换选中）时若仍在暂停，cleanup 里按同样的方式收尾，绝不让历史停摆。
// ---------------------------------------------------------------------------

interface NumberFieldProps {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  step?: number;
  /** 返回 false 表示这个值不合法：恢复原值、不写 store */
  validate?: (v: number) => boolean;
  /** validate 失败时的提示文案 */
  invalidHint?: string;
  /** 进入逐字编辑前调用一次，供调用方记录编辑前的快照 */
  onEditStart?: () => void;
  /** 把 store 复位到编辑前的状态；缺省用 onCommit(编辑前的值) */
  onRevert?: (original: number) => void;
}

function NumberField({
  label,
  value,
  onCommit,
  min,
  step,
  validate,
  invalidHint,
  onEditStart,
  onRevert,
}: NumberFieldProps) {
  const [text, setText] = useState(String(value));
  /** 正在逐字编辑（历史已 pause） */
  const editingRef = useRef(false);
  /** 编辑前的原值 */
  const originalRef = useRef(value);
  /** 最近一次写进 store 的合法值 */
  const liveRef = useRef(value);
  /** 供 cleanup 使用的最新 props */
  const latest = useRef({ value, onCommit, onRevert });
  latest.current = { value, onCommit, onRevert };

  // 编辑期间不要用 store 的回写覆盖用户正在敲的原始文本（会顶掉光标）
  useEffect(() => {
    if (!editingRef.current) setText(String(value));
  }, [value]);

  /** 结束编辑：复位 → resume → 写最终值（final 为 null 表示放弃改动） */
  const finish = (final: number | null, silent = false) => {
    const { value: cur, onCommit: commit, onRevert: revert } = latest.current;
    if (!editingRef.current) {
      // 没进过实时阶段：一次性提交即可（本身就是一步历史）
      if (final !== null && final !== cur) commit(final);
      if (!silent) setText(String(final ?? cur));
      return;
    }
    const original = originalRef.current;
    // 仍在 pause 中：先还原到编辑前，这一步不进历史
    if (revert) revert(original);
    else commit(original);
    resumeHistory();
    editingRef.current = false;
    const target = final ?? original;
    if (target !== original) commit(target);
    if (!silent) setText(String(target));
  };

  const finishRef = useRef(finish);
  finishRef.current = finish;

  // 卸载 / 切换选中：把暂停中的编辑收尾，避免历史永久停摆
  useEffect(
    () => () => {
      if (editingRef.current) finishRef.current(liveRef.current, true);
    },
    [],
  );

  /** 实时阶段：合法就写 store，非法直接忽略 */
  const onType = (raw: string) => {
    setText(raw);
    const trimmed = raw.trim();
    if (trimmed === '') return;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    if (min !== undefined && n < min) return;
    if (validate && !validate(n)) return;
    if (!editingRef.current) {
      originalRef.current = latest.current.value;
      onEditStart?.();
      pauseHistory();
      editingRef.current = true;
    }
    liveRef.current = n;
    if (n !== latest.current.value) latest.current.onCommit(n);
  };

  /** 失焦 / 回车：按原有校验逻辑求最终值（非法则回退原值） */
  const commitFromText = () => {
    const trimmed = text.trim();
    const n = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(n)) {
      finish(null);
      return;
    }
    const clamped = min !== undefined ? Math.max(min, n) : n;
    if (validate && !validate(clamped)) {
      if (invalidHint) notify(invalidHint, 'error');
      finish(null);
      return;
    }
    finish(clamped);
  };

  return (
    <label className="prop-row">
      <span>{label}</span>
      <input
        className="text-input"
        type="number"
        value={text}
        min={min}
        step={step ?? 1}
        onChange={(e) => onType(e.target.value)}
        onBlur={commitFromText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            e.stopPropagation();
            finish(null);
          }
        }}
      />
    </label>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}

function TextField({ label, value, onCommit }: TextFieldProps) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  const commit = () => {
    const v = text.trim();
    if (!v) {
      setText(value);
      return;
    }
    if (v !== value) onCommit(v);
  };

  return (
    <label className="prop-row">
      <span>{label}</span>
      <input
        className="text-input"
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

/**
 * 颜色选择：拖动调色盘时只更新本地值（画布不抖、历史不脏），
 * 只在原生 `change` 事件（关闭取色器 = 一次提交）时写 store —— 保证「一次提交 = 一步撤销」。
 * React 的 onChange 对应的是连续触发的 `input` 事件，所以这里额外挂原生监听。
 */
function ColorField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const safe = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#c9d6e8';
  const [local, setLocal] = useState(safe);
  const ref = useRef<HTMLInputElement | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => setLocal(safe), [safe]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => commitRef.current(el.value);
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, []);

  return (
    <label className="prop-row">
      <span>{label}</span>
      <input
        ref={ref}
        className="color-input"
        type="color"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={(e) => {
          if (e.target.value !== safe) commitRef.current(e.target.value);
        }}
      />
    </label>
  );
}

/** 一组单选 chip */
function ChipChoice<T extends string>({
  label,
  value,
  options,
  labels,
  onSelect,
}: {
  label: string;
  value: T | undefined;
  options: readonly T[];
  labels: Record<T, string>;
  onSelect: (v: T) => void;
}) {
  return (
    <div className="prop-row">
      <span>{label}</span>
      <span className="chip-row">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            className={`chip${value === o ? ' is-active' : ''}`}
            onClick={() => onSelect(o)}
          >
            {labels[o]}
          </button>
        ))}
      </span>
    </div>
  );
}

function StaticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="prop-static">
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

function RemoveButton({ ids, label = TEXT.remove }: { ids: string[]; label?: string }) {
  const removeByIds = usePlanStore((s) => s.removeByIds);
  const clearSelection = useUiStore((s) => s.clearSelection);
  return (
    <button
      type="button"
      className="btn btn-danger btn-block"
      onClick={() => {
        removeByIds(ids);
        clearSelection();
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 各类型面板
// ---------------------------------------------------------------------------

function FurnitureProps({ item }: { item: Furniture }) {
  const updateFurniture = usePlanStore((s) => s.updateFurniture);
  const rotateBy90 = usePlanStore((s) => s.rotateFurnitureBy90);

  return (
    <div className="props">
      <div className="props-kind">
        <b>{TEXT.kind.furniture}</b>
        <span className="props-id">{item.id}</span>
      </div>

      <TextField label={TEXT.name} value={item.name} onCommit={(v) => updateFurniture(item.id, { name: v })} />
      <NumberField
        label={TEXT.width}
        value={item.size.w}
        min={1}
        step={10}
        onCommit={(v) => updateFurniture(item.id, { size: { w: v, d: item.size.d } })}
      />
      <NumberField
        label={TEXT.depth}
        value={item.size.d}
        min={1}
        step={10}
        onCommit={(v) => updateFurniture(item.id, { size: { w: item.size.w, d: v } })}
      />
      <NumberField
        label={TEXT.rotation}
        value={Math.round(item.rotation)}
        step={15}
        onCommit={(v) => updateFurniture(item.id, { rotation: v })}
      />
      <div className="prop-row">
        <span />
        <button type="button" className="btn" onClick={() => rotateBy90(item.id, 1)}>
          {TEXT.rotate90}
        </button>
      </div>
      <NumberField
        label={TEXT.posX}
        value={item.position.x}
        step={10}
        onCommit={(v) => updateFurniture(item.id, { position: { x: v, y: item.position.y } })}
      />
      <NumberField
        label={TEXT.posY}
        value={item.position.y}
        step={10}
        onCommit={(v) => updateFurniture(item.id, { position: { x: item.position.x, y: v } })}
      />
      <ColorField
        label={TEXT.color}
        value={item.color}
        onCommit={(v) => updateFurniture(item.id, { color: v })}
      />
      <label className="prop-row-inline">
        <input
          type="checkbox"
          checked={item.locked}
          onChange={(e) => updateFurniture(item.id, { locked: e.target.checked })}
        />
        <span className="muted">{TEXT.locked}</span>
      </label>

      <RemoveButton ids={[item.id]} />
    </div>
  );
}

function StructureProps({ item }: { item: Structure }) {
  const updateStructure = usePlanStore((s) => s.updateStructure);

  return (
    <div className="props">
      <div className="props-kind">
        <b>
          {TEXT.kind.structure}・{TEXT.structureKind[item.kind]}
        </b>
        <span className="props-id">{item.id}</span>
      </div>

      <NumberField
        label={TEXT.width}
        value={item.width}
        min={1}
        step={5}
        onCommit={(v) => updateStructure(item.id, { width: v })}
      />
      <NumberField
        label={TEXT.depth}
        value={item.depth}
        min={1}
        step={5}
        onCommit={(v) => updateStructure(item.id, { depth: v })}
      />
      <NumberField
        label={TEXT.rotation}
        value={Math.round(item.rotation)}
        step={15}
        onCommit={(v) => updateStructure(item.id, { rotation: v })}
      />
      <NumberField
        label={TEXT.posX}
        value={item.position.x}
        step={10}
        onCommit={(v) => updateStructure(item.id, { position: { x: v, y: item.position.y } })}
      />
      <NumberField
        label={TEXT.posY}
        value={item.position.y}
        step={10}
        onCommit={(v) => updateStructure(item.id, { position: { x: item.position.x, y: v } })}
      />

      <RemoveButton ids={[item.id]} />
    </div>
  );
}

/** 墙可编辑的最小长度 mm（再短就没法稳定确定方向） */
const MIN_WALL_LEN = 100;

function WallProps({ item }: { item: Wall }) {
  const updateWall = usePlanStore((s) => s.updateWall);

  /**
   * 改长度时的基准（编辑前的 start/end）：
   * 起点不动、终点 = 起点 + 方向单位向量 × 新长度。
   * 用快照而不是当前墙来算方向，避免逐字编辑时端点反复取整带来的方向漂移。
   */
  const baseRef = useRef<{ start: Pt; end: Pt }>({ start: item.start, end: item.end });

  const setLength = (len: number) => {
    const base = baseRef.current;
    const d = wallDir(base);
    if (d.x === 0 && d.y === 0) return; // 退化墙：方向未定义，忽略
    updateWall(item.id, {
      end: { x: base.start.x + d.x * len, y: base.start.y + d.y * len },
    });
  };

  return (
    <div className="props">
      <div className="props-kind">
        <b>{TEXT.kind.wall}</b>
        <span className="props-id">{item.id}</span>
      </div>

      <NumberField
        label={TEXT.lengthMm}
        value={Math.round(wallLen(item))}
        min={MIN_WALL_LEN}
        step={10}
        validate={(v) => v >= MIN_WALL_LEN}
        invalidHint={TEXT.wallLengthInvalid}
        onEditStart={() => {
          baseRef.current = { start: item.start, end: item.end };
        }}
        onCommit={setLength}
        onRevert={() => updateWall(item.id, { start: baseRef.current.start, end: baseRef.current.end })}
      />
      <NumberField
        label={TEXT.startX}
        value={item.start.x}
        step={10}
        onCommit={(v) => updateWall(item.id, { start: { x: v, y: item.start.y } })}
      />
      <NumberField
        label={TEXT.startY}
        value={item.start.y}
        step={10}
        onCommit={(v) => updateWall(item.id, { start: { x: item.start.x, y: v } })}
      />
      <NumberField
        label={TEXT.endX}
        value={item.end.x}
        step={10}
        onCommit={(v) => updateWall(item.id, { end: { x: v, y: item.end.y } })}
      />
      <NumberField
        label={TEXT.endY}
        value={item.end.y}
        step={10}
        onCommit={(v) => updateWall(item.id, { end: { x: item.end.x, y: v } })}
      />

      <StaticRow label={TEXT.length} value={formatMm(wallLen(item))} />
      <p className="muted" style={{ margin: '2px 0', fontSize: 12 }}>
        {TEXT.hintReadonly}
      </p>
      <RemoveButton ids={[item.id]} />
    </div>
  );
}

function OpeningProps({ item }: { item: Opening }) {
  const walls = usePlanStore((s) => s.doc.walls);
  const openings = usePlanStore((s) => s.doc.openings);
  const updateOpening = usePlanStore((s) => s.updateOpening);

  const wall = walls.find((w) => w.id === item.wallId);
  const len = wall ? wallLen(wall) : 0;

  /** 新宽度必须：墙放得下 + 重新 clamp 后不与同墙其他开口重叠 */
  const widthOk = (w: number): boolean => {
    if (!wall || !openingFits(w, len)) return false;
    const offset = clampOpeningOffset(item.offset, w, len);
    return !hasOpeningConflict(openings, item.wallId, offset, w, item.id);
  };

  return (
    <div className="props">
      <div className="props-kind">
        <b>{TEXT.kind.opening}</b>
        <span className="props-id">{item.id}</span>
      </div>
      <StaticRow label={TEXT.openingType[item.type]} value={item.type} />

      <NumberField
        label={TEXT.openingWidth}
        value={item.width}
        min={100}
        step={10}
        validate={widthOk}
        invalidHint={strings.m1d.openingWidthInvalid}
        // 宽度变化后洞口可能顶出墙段，一并把 offset 重新 clamp（同一次 set = 一步撤销）
        onCommit={(w) =>
          updateOpening(item.id, { width: w, offset: clampOpeningOffset(item.offset, w, len) })
        }
      />

      {item.type === 'door' && (
        <ChipChoice
          label={TEXT.swing}
          value={item.swing ?? 'in_left'}
          options={SWING_ORDER}
          labels={TEXT.swingLabels}
          onSelect={(s) => updateOpening(item.id, { swing: s })}
        />
      )}

      <StaticRow label={TEXT.offset} value={formatMm(item.offset)} />
      <StaticRow label={TEXT.wallId} value={item.wallId} />
      <p className="muted" style={{ margin: '2px 0', fontSize: 12 }}>
        {TEXT.hintOpening}
      </p>
      <RemoveButton ids={[item.id]} />
    </div>
  );
}

function RoomProps({ item }: { item: Room }) {
  const updateRoom = usePlanStore((s) => s.updateRoom);
  const displayUnit = useUiStore((s) => s.displayUnit);
  const areaMm2 = polygonAreaMm2(item.polygon);

  return (
    <div className="props">
      <div className="props-kind">
        <b>{TEXT.kind.room}</b>
        <span className="props-id">{item.id}</span>
      </div>

      <TextField label={TEXT.name} value={item.name} onCommit={(v) => updateRoom(item.id, { name: v })} />
      <ChipChoice<FloorType>
        label={TEXT.floor}
        value={item.floor}
        options={FLOOR_ORDER}
        labels={FLOOR_LABELS}
        onSelect={(f) => updateRoom(item.id, { floor: f })}
      />
      <StaticRow label={TEXT.area} value={formatAreaBoth(areaMm2, displayUnit)} />
      <StaticRow label={TEXT.vertices} value={formatInt(item.polygon.length)} />
      <p className="muted" style={{ margin: '2px 0', fontSize: 12 }}>
        {TEXT.roomHint}
      </p>
      <RemoveButton ids={[item.id]} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function PropertiesPanel() {
  const selection = useUiStore((s) => s.selection);
  const doc = usePlanStore((s) => s.doc);

  if (selection.length === 0) return <p className="empty">{TEXT.none}</p>;

  if (selection.length > 1) {
    return (
      <div className="props">
        <p className="empty" style={{ margin: '4px 0' }}>
          {TEXT.multi(selection.length)}
        </p>
        <RemoveButton ids={selection} label={TEXT.removeAll} />
      </div>
    );
  }

  const id = selection[0];
  // 底图是单例、没有 id 前缀（M2）
  if (id === UNDERLAY_ID) return <UnderlayPanel />;

  // key={id}：切换选中对象时强制重建输入框，
  // 让暂停中的编辑在 cleanup 里收尾（历史不会跨对象串味）
  switch (idPrefix(id)) {
    case 'f': {
      const item = doc.furniture.find((f) => f.id === id);
      return item ? <FurnitureProps key={id} item={item} /> : <p className="empty">{TEXT.missing}</p>;
    }
    case 's': {
      const item = doc.structures.find((s) => s.id === id);
      return item ? <StructureProps key={id} item={item} /> : <p className="empty">{TEXT.missing}</p>;
    }
    case 'w': {
      const item = doc.walls.find((w) => w.id === id);
      return item ? <WallProps key={id} item={item} /> : <p className="empty">{TEXT.missing}</p>;
    }
    case 'o': {
      const item = doc.openings.find((o) => o.id === id);
      return item ? <OpeningProps key={id} item={item} /> : <p className="empty">{TEXT.missing}</p>;
    }
    case 'r': {
      const item = doc.rooms.find((r) => r.id === id);
      return item ? <RoomProps key={id} item={item} /> : <p className="empty">{TEXT.missing}</p>;
    }
    default:
      return (
        <div className="props">
          <div className="props-kind">
            <b>{TEXT.multi(1)}</b>
            <span className="props-id">{id}</span>
          </div>
          <RemoveButton ids={[id]} />
        </div>
      );
  }
}

export default PropertiesPanel;
