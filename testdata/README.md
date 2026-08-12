# testdata —— AI 识别的测试图

把要测的**間取り図**（户型图）直接放在这个目录下即可：

```
testdata/
├── README.md            ← 本文件
├── synthetic-01.png     ← 合成的简单样例（冒烟测试用，可以删）
├── 你的图1.jpg
└── 你的图2.png
```

## 规则

- 支持 `.jpg` / `.jpeg` / `.png` / `.webp`；
- 脚本**不做压缩**，直接 base64 发送，所以**单张 > 3MB 会被跳过并警告**
  （请自己先缩到长边 1600px 左右，和前端 `utils/underlayImage.ts` 的压缩口径一致）；
- 文件名会出现在结果文件名与汇总表里，建议用简短的 ASCII 名字（`mansion-2ldk.png` 之类）。

## 跑对比

```bash
# 默认跑三个模型 × 目录下所有图（真实 API 调用，会产生费用！）
node --env-file=.env server/test-recognize.mjs

# 只跑一个模型 / 换目录 / 换输出位置
node --env-file=.env server/test-recognize.mjs --models qwen/qwen3.7-flash
node --env-file=.env server/test-recognize.mjs --dir testdata --out testdata/results
```

结果写在 `testdata/results/<运行时间戳>/`：

- `<图名>__<模型名>.json` —— 识别原始结果 + solver 摘要 + usage/耗时；
- `summary.md` —— 行=图、列=模型的对比表 + 费用小计 + solver warnings 汇总。

> 需要 `.env` 里的 `OPENROUTER_APIKEY`。图片与结果都不会被提交（见 `.gitignore`）。
