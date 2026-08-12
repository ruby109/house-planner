/**
 * opencv.js 的加载与 Mat 生命周期小工具。
 *
 * `@techstark/opencv-js` 的模块对象在 WASM 初始化完成前是**空壳**（`cv.Mat` 还是
 * undefined），初始化完成后模块自身的 `then` 会被删掉并 resolve 出真正的模块。
 * 所以任何用到 cv 的地方都必须先 `const cv = await ensureCv()`。
 *
 * 注意 Node 的 CJS 互操作：`import * as ns` 只拿得到 `ns.default`（cjs-module-lexer
 * 扫不出具名导出），所以这里要手动往下取一层。
 */
import * as cvNamespace from '@techstark/opencv-js';

export type CvModule = typeof cvNamespace;
export type Mat = cvNamespace.Mat;
export type MatVector = cvNamespace.MatVector;

let pending: Promise<CvModule> | null = null;

/** 等 opencv.js 的 WASM 初始化完成，返回可用的模块（结果缓存） */
export function ensureCv(): Promise<CvModule> {
  if (!pending) {
    const holder = cvNamespace as unknown as { default?: unknown };
    const raw = (holder.default ?? cvNamespace) as CvModule;
    // 未初始化时 raw 是 thenable；已初始化时 then 已被删除，Promise.resolve 原样返回
    pending = Promise.resolve(raw as unknown as PromiseLike<CvModule>);
  }
  return pending;
}

/**
 * 简易 Mat 作用域：所有临时 Mat 登记进来，结束时统一 delete。
 * opencv.js 是手动内存管理，漏一个就是 WASM 堆泄漏。
 */
export class MatScope {
  private items: Array<{ delete(): void }> = [];

  keep<T extends { delete(): void }>(m: T): T {
    this.items.push(m);
    return m;
  }

  /** 从作用域里摘出来（调用方接管生命周期） */
  release<T extends { delete(): void }>(m: T): T {
    const i = this.items.indexOf(m);
    if (i >= 0) this.items.splice(i, 1);
    return m;
  }

  dispose(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.items[i].delete();
      } catch {
        /* 已经被 delete 过就算了 */
      }
    }
    this.items.length = 0;
  }
}

/** 8UC1 mask（0/255）→ 普通 Uint8Array 拷贝，方便脱离 WASM 堆使用 */
export function maskToArray(mat: Mat): Uint8Array {
  return new Uint8Array(mat.data);
}

/** 普通 Uint8Array（0/255）→ 8UC1 Mat */
export function arrayToMask(cv: CvModule, arr: Uint8Array, width: number, height: number): Mat {
  const mat = new cv.Mat(height, width, cv.CV_8UC1);
  mat.data.set(arr);
  return mat;
}

/** 奇数化（很多 OpenCV 核函数要求 kernel/blockSize 是奇数） */
export function toOdd(v: number): number {
  const i = Math.max(1, Math.round(v));
  return i % 2 === 1 ? i : i + 1;
}
