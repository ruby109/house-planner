/**
 * 右侧栏：上 = 家具库（搜索 / 分类 / 点击进入放置模式 / 自定义尺寸），
 *         下 = 选中元素属性面板（PropertiesPanel）。
 *
 * 点击家具项 → uiStore.setPendingFurniture(...)，同时切到 furniture_place 工具；
 * 画布上的实时预览与落地由 tools/furnitureTool 负责。
 */
import { useMemo, useState } from 'react';
import {
  CATALOG,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  catalogByCategory,
  searchCatalog,
} from '../model/catalog';
import { DEFAULT_FURNITURE_COLOR } from '../model/defaults';
import type { FurnitureCategory } from '../model/types';
import { strings } from '../ui/strings';
import { usePlanStore } from '../store/planStore';
import { useUiStore } from '../store/uiStore';
import { UNDERLAY_ID } from '../model/defaults';
import { formatInt } from '../utils/units';
import { PropertiesPanel } from './PropertiesPanel';
import { UnderlayPanel } from './UnderlayPanel';
import './panels.css';

type CategoryFilter = 'all' | FurnitureCategory;

const TEXT = {
  all: '全部',
  placeHint: '点击家具进入放置模式，画布上连续点击放置；Esc 退出。',
  placing: '正在放置',
  exitPlacing: '退出',
  custom: '自定义家具',
  customName: '名称',
  customW: '宽 mm',
  customD: '深 mm',
  customColor: '颜色',
  customSubmit: '开始放置',
  customDefaultName: '自定义家具',
};

const CUSTOM_MIN = 1;

function CustomFurnitureForm() {
  const setPendingFurniture = useUiStore((s) => s.setPendingFurniture);
  const [name, setName] = useState('');
  const [w, setW] = useState('900');
  const [d, setD] = useState('600');
  const [color, setColor] = useState(DEFAULT_FURNITURE_COLOR);

  const wNum = Math.round(Number(w));
  const dNum = Math.round(Number(d));
  const valid = Number.isFinite(wNum) && Number.isFinite(dNum) && wNum >= CUSTOM_MIN && dNum >= CUSTOM_MIN;

  return (
    <details className="catalog-custom">
      <summary>{TEXT.custom}</summary>
      <div className="form-grid">
        <span>{TEXT.customName}</span>
        <input
          className="text-input"
          type="text"
          value={name}
          placeholder={TEXT.customDefaultName}
          onChange={(e) => setName(e.target.value)}
        />
        <span>{TEXT.customW}</span>
        <input
          className="text-input"
          type="number"
          min={CUSTOM_MIN}
          step={10}
          value={w}
          onChange={(e) => setW(e.target.value)}
        />
        <span>{TEXT.customD}</span>
        <input
          className="text-input"
          type="number"
          min={CUSTOM_MIN}
          step={10}
          value={d}
          onChange={(e) => setD(e.target.value)}
        />
        <span>{TEXT.customColor}</span>
        <input
          className="color-input"
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        />
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!valid}
          onClick={() =>
            setPendingFurniture({
              catalogId: null,
              name: name.trim() || TEXT.customDefaultName,
              w: wNum,
              d: dNum,
              color,
            })
          }
        >
          {TEXT.customSubmit}
        </button>
      </div>
    </details>
  );
}

export function Sidebar() {
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const pending = useUiStore((s) => s.pendingFurniture);
  const setPendingFurniture = useUiStore((s) => s.setPendingFurniture);
  const hasUnderlay = usePlanStore((s) => s.doc.underlay !== null);
  const underlaySelected = useUiStore((s) => s.selection[0] === UNDERLAY_ID);

  const groups = useMemo(() => {
    const base = category === 'all' ? CATALOG : CATALOG.filter((i) => i.category === category);
    return catalogByCategory(searchCatalog(keyword, base));
  }, [keyword, category]);

  const total = groups.reduce((n, [, list]) => n + list.length, 0);

  return (
    <aside className="sidebar">
      <section className="panel panel-catalog">
        <header className="panel-header">
          <h2>{strings.sidebar.catalogTitle}</h2>
          <span className="muted">{total}</span>
        </header>

        <div className="panel-controls">
          <input
            className="text-input"
            type="search"
            value={keyword}
            placeholder={strings.sidebar.searchPlaceholder}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <div className="chip-row">
            <button
              type="button"
              className={`chip${category === 'all' ? ' is-active' : ''}`}
              onClick={() => setCategory('all')}
            >
              {TEXT.all}
            </button>
            {CATEGORY_ORDER.map((c) => (
              <button
                key={c}
                type="button"
                className={`chip${category === c ? ' is-active' : ''}`}
                onClick={() => setCategory(c)}
              >
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </div>

        {pending && (
          <div className="pending-bar">
            <span className="swatch" style={{ background: pending.color }} />
            <span className="pending-name">
              {TEXT.placing}：{pending.name}（{formatInt(pending.w)}×{formatInt(pending.d)}）
            </span>
            <button type="button" className="btn" onClick={() => setPendingFurniture(null)}>
              {TEXT.exitPlacing}
            </button>
          </div>
        )}

        <div className="panel-body">
          {total === 0 && <p className="empty">{strings.sidebar.empty}</p>}
          {groups.map(([cat, items]) => (
            <div key={cat} className="catalog-group">
              <h3 className="catalog-group-title">{CATEGORY_LABELS[cat]}</h3>
              <ul className="catalog-list">
                {items.map((item) => {
                  const active = pending?.catalogId === item.catalogId;
                  return (
                    <li key={item.catalogId}>
                      <button
                        type="button"
                        className={`catalog-item${active ? ' is-active' : ''}`}
                        title={item.nameJa}
                        onClick={() =>
                          setPendingFurniture({
                            catalogId: item.catalogId,
                            name: item.name,
                            w: item.w,
                            d: item.d,
                            color: item.color,
                          })
                        }
                      >
                        <span className="swatch" style={{ background: item.color }} />
                        <span className="catalog-name">
                          {item.name}
                          <em className="catalog-name-ja">{item.nameJa}</em>
                        </span>
                        <span className="catalog-size">
                          {formatInt(item.w)}×{formatInt(item.d)}
                          <em>{strings.sidebar.sizeUnit}</em>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          <CustomFurnitureForm />
        </div>

        <footer className="panel-footer muted">{TEXT.placeHint}</footer>
      </section>

      {/* 有底图时常驻；选中底图时改由属性面板展示同一套控件，避免出现两遍 */}
      {hasUnderlay && !underlaySelected && (
        <section className="panel panel-underlay">
          <div className="panel-body">
            <UnderlayPanel />
          </div>
        </section>
      )}

      <section className="panel panel-properties">
        <header className="panel-header">
          <h2>{strings.sidebar.propertiesTitle}</h2>
        </header>
        <div className="panel-body">
          <PropertiesPanel />
        </div>
      </section>
    </aside>
  );
}

export default Sidebar;
