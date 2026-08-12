/**
 * Zhang-Suen 细化（opencv.js 没打包 ximgproc.thinning，自写）。
 *
 * **纯 TS、无依赖**，配 vitest 单测。输入输出都是 0/255 的 mask（行主序，长度 = w×h）。
 */

/** 邻域取值（越界当背景） */
function at(src: Uint8Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  return src[y * w + x] ? 1 : 0;
}

/**
 * Zhang-Suen 迭代细化，把粗笔画收成 1px 宽的中心线。
 *
 * 每轮分两个子迭代，子迭代内所有像素并行判定（先标记后统一删除），
 * 直到某一轮没有像素被删除为止。
 *
 * @param mask   0/255 的前景 mask
 * @param maxIterations 保险丝：图很大又有大块实心区域时避免跑太久
 */
export function zhangSuenThin(mask: Uint8Array, width: number, height: number, maxIterations = 200): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 1 : 0;

  const doomed: number[] = [];

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;

    for (let step = 0; step < 2; step++) {
      doomed.length = 0;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          if (!out[idx]) continue;

          // P2..P9：从正上方开始顺时针
          const p2 = at(out, width, height, x, y - 1);
          const p3 = at(out, width, height, x + 1, y - 1);
          const p4 = at(out, width, height, x + 1, y);
          const p5 = at(out, width, height, x + 1, y + 1);
          const p6 = at(out, width, height, x, y + 1);
          const p7 = at(out, width, height, x - 1, y + 1);
          const p8 = at(out, width, height, x - 1, y);
          const p9 = at(out, width, height, x - 1, y - 1);

          // B(P1)：邻域里前景像素个数
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;

          // A(P1)：绕一圈 0→1 的次数
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) a++;
          if (a !== 1) continue;

          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }

          doomed.push(idx);
        }
      }

      if (doomed.length > 0) {
        changed = true;
        for (const idx of doomed) out[idx] = 0;
      }
    }

    if (!changed) break;
  }

  for (let i = 0; i < out.length; i++) out[i] = out[i] ? 255 : 0;
  return out;
}

/**
 * 去掉骨架上的毛刺：长度 ≤ `maxSpurLength` 且一端悬空的分支整条删掉。
 * 细化会在 T 型接点、粗笔画端头长出小胡子，Hough 会把它们当短线段。
 */
export function pruneSpurs(skeleton: Uint8Array, width: number, height: number, maxSpurLength: number): Uint8Array {
  const out = new Uint8Array(skeleton);
  if (maxSpurLength <= 0) return out;

  const neighborIdx = (idx: number): number[] => {
    const x = idx % width;
    const y = (idx - x) / width;
    const list: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (out[n]) list.push(n);
      }
    }
    return list;
  };

  /**
   * 交叉数 A(P)：绕 8 邻域一圈的 0→1 跳变次数。
   * 1 = 端点，2 = 线上的普通点，≥3 = 分叉点。
   *
   * **不能**直接数邻居个数：紧贴一条横线的毛刺根部，邻居有 3 个（横线上连着的三格），
   * 但那三格彼此相邻算一段，交叉数还是 1，本来就该当端点处理。
   */
  const crossingNumber = (idx: number): number => {
    const x = idx % width;
    const y = (idx - x) / width;
    const ring = [
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
    ];
    const vals = ring.map(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return 0;
      return out[ny * width + nx] ? 1 : 0;
    });
    let a = 0;
    for (let k = 0; k < 8; k++) if (vals[k] === 0 && vals[(k + 1) % 8] === 1) a++;
    return a;
  };

  // 多轮：删掉一根毛刺可能让相邻的分支也变成毛刺
  for (let round = 0; round < 4; round++) {
    const doomed = new Set<number>();

    for (let idx = 0; idx < out.length; idx++) {
      if (!out[idx] || doomed.has(idx)) continue;
      if (neighborIdx(idx).length !== 1) continue; // 只从端点出发

      const path: number[] = [idx];
      let prev = -1;
      let cur = idx;
      let hitJunction = false;

      while (path.length <= maxSpurLength) {
        const ns = neighborIdx(cur).filter((n) => n !== prev);
        if (ns.length === 0) break; // 走到另一个端点：整条是独立短线，交给长度过滤
        if (ns.length > 1) {
          hitJunction = true; // cur 是分叉点，不删它
          break;
        }
        prev = cur;
        cur = ns[0];
        if (crossingNumber(cur) >= 3) {
          hitJunction = true;
          break;
        }
        path.push(cur);
      }

      if (hitJunction && path.length <= maxSpurLength) {
        for (const p of path) doomed.add(p);
      }
    }

    if (doomed.size === 0) break;
    for (const p of doomed) out[p] = 0;
  }

  return out;
}
