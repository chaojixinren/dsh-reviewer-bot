# DSH Reviewer Bot

原生 [DeepSeek Harness](https://dshfind.com/zh/plugins/deepseek-ai/deepseek-harness) 插件形态的代码评审机器人。跨代码平台，规则可插拔，可本地重放。

> **当前状态：M1（只读评审闭环）进行中。** 领域类型（`review-core`）、forge 接口 + 注册表 + 锚定器、信任判定（`trust-policy`）、`forge-github` provider、`tool-review` 只读工具、`review-runtime` 的 `validate` 校验链已落地并配单测（195 例），`signature-probe` 在真实容器里验证扩展点签名（9/9）。评审管线其余阶段、进度上报、规则、GitLab provider 与 driver 外壳仍未实现。

## 为什么不是又一个 CI Action

现有方案把 DSH 当成一个黑盒 Docker worker 来调用——拿不到插件生态、每次事件冷启动、规则写死在 prompt 里、调 prompt 只能推 PR 等 CI。

我们直接长在 Cordis 扩展点上：

| | 现有方案 | DSH Reviewer Bot |
|---|---|---|
| 与 DSH 的关系 | 外部进程调用 | 原生插件，共享 `ctx` |
| 平台支持 | 仅 GitHub | GitHub / GitLab / Gitea / 本地 |
| 评审规则 | prompt 内写死 | 规则包可独立发布安装 |
| 本地迭代 | 推 PR 等 CI | `dshrb review --local` / `dshrb replay` |
| 运行形态 | 一次性 Action | Action / Daemon / DSH profile / CLI |
| Docker | 写模式硬依赖 | 可选隔离后端 |

信任模型完整继承现有方案的四层设计（这部分它做得扎实），并显式化为可测试的能力矩阵，无任何放松。

## 设计文档

完整设计在 [`docs/`](./docs/README.md)，含 mermaid 图：

- [架构总览](./docs/02-architecture.md) · [评审管线](./docs/03-review-pipeline.md) · [信任模型](./docs/04-trust-model.md)
- [插件装配](./docs/05-plugin-composition.md) · [Forge 抽象](./docs/06-forge-abstraction.md) · [数据契约](./docs/07-data-contracts.md)
- [部署形态](./docs/08-deployment-modes.md) · [路线图](./docs/09-roadmap.md) · [设计目标](./docs/01-design-goals.md)

## 三种安装方式

```bash
# DSH 生态用户：装进既有 profile，与其他插件共享 ctx
dsh plugin add @dshrb/bundle

# GitHub Action：见 examples/review.yml
# Daemon：见 docs/08-deployment-modes.md
```

## 命令

评审者在 PR 评论**首行**触发（非首行不触发，避免引用他人评论误触）：

| 命令 | 作用 | 最低信任 |
|---|---|---|
| `@dsr review` | 重新评审 | untrusted |
| `@dsr explain <path>` | 解释某文件改动 | untrusted |
| `@dsr diagnose` | 读失败 CI 定位原因 | trusted-read |
| `@dsr fix` | 改代码并跑校验 | trusted-write + `allow-write` |
| `@dsr rules` | 打印生效规则 | untrusted |

`@dsr fix` 本身不授予任何写权限：需要 actor 权限与仓库配置**同时**成立。

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm run check     # typecheck + lint + test
```

Node 22.19+ / 24+ / 26，pnpm 11.x，对齐上游 DSH 的 engine floor。

想参与开发？先读 [贡献指南](./CONTRIBUTING.md)。

## 仓库结构

```
docs/                    设计文档（mermaid）
packages/core/           领域类型 · Forge 接口 · 信任策略 · 规则注册表 · 管线 · 进度上报
packages/forge/          GitHub / GitLab provider
packages/tools/          模型可见评审工具
packages/rules/          基线规则包
packages/drivers/        Action / Webhook / CLI 三种外壳
bundle/                  dsh.bundle 声明，供 dsh plugin add
examples/                workflow 模板
```

## 安全

- 凭据（forge token、DeepSeek API Key）在任何信任等级下都不进入 Agent 工作区
- 仓库内容、diff、评论、CI 日志、模型输出全部视为不可信数据
- 校验命令是 JSON argv 数组，不过 shell
- `.github/**`、`package.json` 的 `scripts`、二进制文件为 `ctx.tools.guard()` 永久红线，后续 listener 无法翻案
- 完整威胁清单见 [信任模型](./docs/04-trust-model.md)

发现安全问题请私下报告，勿开公开 issue。

## 许可

MIT。非 DeepSeek 官方项目。
