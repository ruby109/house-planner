/**
 * M5.2 单测：摘掉假隔断之后的局部墙网修补（见 docs/CV-PIPELINE.md 第 10 节）。
 *
 * 关注点只有一个：**摘墙不许留下新的悬空线头**。
 * 全部是 mm 域几何 —— `cv/wallNet.ts` 的判据本身是域无关的，这里正好也验证了这一点。
 */
import { describe, expect, it } from 'vitest';
import type { MmSegment } from './cvGeometry';
import { repairWallNet } from './wallRepair';

const THICKNESS = 140;

function h(x1: number, x2: number, y: number): MmSegment {
  return { x1, y1: y, x2, y2: y, orient: 'h' };
}
function v(x: number, y1: number, y2: number): MmSegment {
  return { x1: x, y1, x2: x, y2, orient: 'v' };
}

/** 一个 4000×3000 的房子，中间横着一道 y=1500 的假隔断 */
const SHELL: MmSegment[] = [h(0, 4000, 0), h(0, 4000, 3000), v(0, 0, 3000), v(4000, 0, 3000)];
const PARTITION = h(0, 4000, 1500);

describe('repairWallNet', () => {
  it('没摘任何墙时原样返回', () => {
    const out = repairWallNet(SHELL, [], THICKNESS);
    expect(out.segments).toEqual(SHELL);
    expect(out.extended).toBe(0);
    expect(out.dropped).toBe(0);
    expect(out.danglingAfter).toBe(out.danglingBefore);
  });

  it('T 接在假隔断上的短残端被当碎屑清掉，悬空端点不增加', () => {
    // 200mm 的小柱头原本接在隔断上，隔断一摘它两端就都自由了
    const stub = v(2000, 1500, 1700);
    const before = [...SHELL, PARTITION, stub];
    const out = repairWallNet(
      before.filter((s) => s !== PARTITION),
      [PARTITION],
      THICKNESS,
    );
    expect(out.dropped).toBe(1);
    expect(out.segments).toHaveLength(4);
    expect(out.danglingAfter).toBeLessThanOrEqual(out.danglingBefore);
  });

  it('够得着别的墙的残端重新 T 接上去，悬空端点不增加', () => {
    // 摘掉 y=1500 那道，残端离 y=1700 那道 200mm：超出「算已接上」的容差，但在搜索半径内
    const second = h(0, 4000, 1700);
    const stub = v(2000, 1500, 3000);
    const before = [...SHELL, PARTITION, second, stub];
    const out = repairWallNet(
      before.filter((s) => s !== PARTITION),
      [PARTITION],
      THICKNESS,
    );
    expect(out.dropped).toBe(0);
    expect(out.extended).toBe(1);
    const repaired = out.segments.find((s) => s.orient === 'v' && s.x1 === 2000)!;
    expect(Math.min(repaired.y1, repaired.y2)).toBeCloseTo(1700, 6);
    expect(out.danglingAfter).toBeLessThanOrEqual(out.danglingBefore);
  });

  it('只动被摘墙段附近的墙：远处本来就悬空的线头原样留着', () => {
    // 房子另一头有个自由端（阳台矮墙那类），摘的是 y=1500 的隔断，够不着它
    const balcony = h(6000, 8000, 2800);
    const before = [...SHELL, PARTITION, balcony];
    const out = repairWallNet(
      before.filter((s) => s !== PARTITION),
      [PARTITION],
      THICKNESS,
    );
    expect(out.segments).toContainEqual(balcony);
  });
});
