/**
 * pngjs 没有自带类型声明，而项目里没有装 @types/node（装了会和 DOM lib 打架）。
 * 这里只声明 decode.ts 真正用到的那一小块 API，参数/返回值一律用 Uint8Array
 * （Node 的 Buffer 本来就是 Uint8Array 的子类，运行时兼容）。
 */
declare module 'pngjs' {
  export interface PngData {
    width: number;
    height: number;
    data: Uint8Array;
  }

  export class PNG implements PngData {
    constructor(options?: { width?: number; height?: number; colorType?: number; inputHasAlpha?: boolean });
    width: number;
    height: number;
    data: Uint8Array;
    static sync: {
      read(buffer: Uint8Array): PNG;
      write(png: PngData, options?: { colorType?: number }): Uint8Array;
    };
  }
}
