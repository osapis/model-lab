# 第三方组件与许可证

Model Lab 自有代码采用 [MIT License](LICENSE)。第三方组件保留各自的版权与许可证；项目的 MIT 许可不会替换这些条款。准确依赖版本见 `package-lock.json`，安装后的完整许可文件位于对应的 `node_modules/<package>/LICENSE*`。

## 主要依赖

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| React、React DOM | 前端界面 | MIT |
| Lucide React | 界面图标 | ISC；部分图标源自 MIT 许可的 Feather |
| Express | Node HTTP 服务 | MIT |
| AWS SDK for JavaScript | S3 兼容存储 | Apache-2.0 |
| cron-parser | 定时表达式 | MIT |
| tsx、Undici、Zod | TypeScript 执行、HTTP、输入校验 | MIT |
| Vite、Concurrently | 开发与构建 | MIT |
| TypeScript | 类型检查 | Apache-2.0 |
| Wrangler、Cloudflare Workers Types | Cloudflare 构建与类型 | MIT OR Apache-2.0 |

开发依赖还间接使用 `caniuse-lite` 的 CC-BY-4.0 浏览器兼容数据，以及 Sharp／libvips 的 Apache-2.0／LGPL-3.0-or-later 组件。完整清单以锁文件与各组件附带的许可为准。运行镜像通过 `npm ci --omit=dev` 安装生产依赖，开发工具留在构建阶段。重新分发开发镜像、第三方二进制或修改过的组件时，应同时保留它们的许可、版权声明和适用的源码说明。

`samples/` 中的 HTML 与文本为本项目开发时生成的演示样例，不是第三方服务的测评背书。用户运行后生成的内容不属于仓库附带的依赖或固定测评成绩。

## React / React DOM

以下声明来自 React 与 React DOM 随附的 MIT 许可证：

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Lucide

以下声明来自 Lucide React 随附的许可证：

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
