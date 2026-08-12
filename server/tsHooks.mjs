/**
 * 让 Node 能直接 import 前端那些「省略扩展名」的 TS 模块。
 *
 * 背景：`src/ai/solve.ts` 里写的是 `import … from '../model/defaults'`（vite / tsc 风格），
 * 而 Node 的 ESM 解析要求写全扩展名，会直接 ERR_MODULE_NOT_FOUND。
 * Node 24 自带类型剥离，只差这一步解析——用内置的 `module.registerHooks()`
 * 补一个同步 resolve hook 即可，**不需要引入 tsx / ts-node 之类的运行时依赖**。
 *
 * 用法（必须在 **动态** import 目标模块之前完成）：
 *
 *   import './tsHooks.mjs';
 *   const { solveRecognizeResult } = await import('../src/ai/solve.ts');
 *
 * 注意静态 import 在链接阶段就要解析完，所以目标模块只能用 `await import()`。
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/** 依次尝试补这些扩展名 */
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 只管相对路径且没写扩展名的
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
      for (const ext of EXTENSIONS) {
        const candidate = specifier + ext;
        try {
          if (existsSync(fileURLToPath(new URL(candidate, context.parentURL)))) {
            return nextResolve(candidate, context);
          }
        } catch {
          /* URL 拼不出来就换下一个 */
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
