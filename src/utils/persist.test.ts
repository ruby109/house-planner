import { describe, expect, it } from 'vitest';
import { createEmptyDoc } from '../model/defaults';
import { formatClock, isQuotaExceededError, jsonFileName, parsePlanDoc } from './persist';

describe('jsonFileName', () => {
  const at = new Date(2026, 7, 11); // 2026-08-11（本地时区）

  it('包含文档名与日期', () => {
    expect(jsonFileName('我的家', at)).toBe('我的家-20260811.json');
  });

  it('替换掉文件名里不安全的字符与空白', () => {
    expect(jsonFileName('a/b c:d', at)).toBe('a_b_c_d-20260811.json');
  });

  it('空名字有兜底', () => {
    expect(jsonFileName('   ', at)).toBe('house-plan-20260811.json');
  });

  it('月/日补零', () => {
    expect(jsonFileName('x', new Date(2026, 0, 5))).toBe('x-20260105.json');
  });
});

describe('formatClock', () => {
  it('HH:MM 补零', () => {
    expect(formatClock(new Date(2026, 7, 11, 9, 5).getTime())).toBe('09:05');
    expect(formatClock(new Date(2026, 7, 11, 23, 59).getTime())).toBe('23:59');
  });
});

describe('isQuotaExceededError', () => {
  it('识别各浏览器的配额错误', () => {
    expect(isQuotaExceededError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaExceededError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaExceededError({ name: 'Whatever', code: 22 })).toBe(true);
    expect(isQuotaExceededError({ code: 1014 })).toBe(true);
  });

  it('其它错误不误判', () => {
    expect(isQuotaExceededError(new TypeError('boom'))).toBe(false);
    expect(isQuotaExceededError('QuotaExceededError')).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
  });
});

describe('parsePlanDoc', () => {
  it('合法文档原样返回', () => {
    const doc = createEmptyDoc('测试');
    const parsed = parsePlanDoc(JSON.stringify(doc));
    expect(parsed).toEqual(doc);
  });

  it('非 JSON 文本 → null', () => {
    expect(parsePlanDoc('not json')).toBeNull();
  });

  it('缺字段 / 版本不对 → null（zod 校验失败不覆盖当前文档）', () => {
    expect(parsePlanDoc('{"version":1}')).toBeNull();
    const bad = { ...createEmptyDoc(), version: 2 };
    expect(parsePlanDoc(JSON.stringify(bad))).toBeNull();
  });

  it('坐标不是整数 → null', () => {
    const doc = createEmptyDoc();
    doc.walls.push({ id: 'w_1', start: { x: 0.5, y: 0 }, end: { x: 910, y: 0 } });
    expect(parsePlanDoc(JSON.stringify(doc))).toBeNull();
  });

  it('带底图的文档能往返（M2）', () => {
    const doc = createEmptyDoc();
    doc.underlay = {
      imageDataUrl: 'data:image/jpeg;base64,/9j/4AAQ',
      opacity: 0.5,
      mmPerPixel: 5.6875,
      offset: { x: -4550, y: -3413 },
      rotation: 0,
      locked: true,
    };
    const parsed = parsePlanDoc(JSON.stringify(doc));
    expect(parsed).toEqual(doc);
    expect(parsed?.underlay?.mmPerPixel).toBeCloseTo(5.6875, 9);
  });

  it('底图字段非法 → null（offset 必须是整数 mm、opacity 在 0..1）', () => {
    const base = createEmptyDoc();
    const bad1 = {
      ...base,
      underlay: {
        imageDataUrl: 'x',
        opacity: 1.5,
        mmPerPixel: 5,
        offset: { x: 0, y: 0 },
        rotation: 0,
        locked: true,
      },
    };
    expect(parsePlanDoc(JSON.stringify(bad1))).toBeNull();
    const bad2 = {
      ...base,
      underlay: {
        imageDataUrl: 'x',
        opacity: 0.5,
        mmPerPixel: 0,
        offset: { x: 0.5, y: 0 },
        rotation: 0,
        locked: true,
      },
    };
    expect(parsePlanDoc(JSON.stringify(bad2))).toBeNull();
  });

  it('带房间的完整文档能通过校验', () => {
    const doc = createEmptyDoc();
    doc.rooms.push({
      id: 'r_1',
      name: '和室',
      floor: 'tatami',
      polygon: [
        { x: 0, y: 0 },
        { x: 2730, y: 0 },
        { x: 2730, y: 3640 },
        { x: 0, y: 3640 },
      ],
    });
    expect(parsePlanDoc(JSON.stringify(doc))?.rooms).toHaveLength(1);
  });
});
