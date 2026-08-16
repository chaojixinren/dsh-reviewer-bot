<p align="center"><img src="./public/banner.svg" alt="DSH Reviewer Bot" /></p>

原生 [DeepSeek Harness](https://dshfind.com/zh/plugins/deepseek-ai/deepseek-harness) 插件形态的代码评审机器人。跨代码平台，规则可插拔，可本地重放。

<p align="center">
  <a href="https://github.com/chaojixinren/dsh-reviewer-bot/actions/workflows/ci.yml"><img src="https://github.com/chaojixinren/dsh-reviewer-bot/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="#许可"><img src="https://img.shields.io/badge/License-MIT-2ea44f" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Node-22.19%2B%20%7C%2024%2B-339933" alt="Node 22.19+ | 24+" />
  <img src="https://img.shields.io/badge/TypeScript-5.9.2-3178c6" alt="TypeScript 5.9.2" />
  <img src="https://img.shields.io/badge/pnpm-11.7.0-f69220" alt="pnpm 11.7.0" />
  <a href="https://dshfind.com/zh/plugins/chaojixinren/dsh-reviewer-bot?ref=badge">
    <img
      src="https://dshfind.com/api/badge/chaojixinren/dsh-reviewer-bot?lang=zh"
      alt="dshfind"
    />
  </a>
</p>
<div align="center">
  <a href="https://dshfind.com/zh/plugins/chaojixinren/dsh-reviewer-bot?ref=badge">
    <img
      alt="dshfind 展示卡"
      src="https://dshfind.com/api/card/chaojixinren/dsh-reviewer-bot?lang=zh"
      width="440"
    />
  </a>
</div>

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

<p align="center">
  <img src="./public/display1.png" width="42%" />
  <img src="./public/display2.png" width="56%" />
</p>

## 设计文档

完整设计在 [`docs/`](./docs/README.md)，含 mermaid 图：

- [架构总览](./docs/02-architecture.md) · [评审管线](./docs/03-review-pipeline.md) · [信任模型](./docs/04-trust-model.md)
- [插件装配](./docs/05-plugin-composition.md) · [打包](./docs/05-packaging.md) · [Forge 抽象](./docs/06-forge-abstraction.md) · [数据契约](./docs/07-data-contracts.md)
- [部署形态](./docs/08-deployment-modes.md) · [路线图](./docs/09-roadmap.md) · [设计目标](./docs/01-design-goals.md)

## 三种安装方式

按场景选一种接入：

| 方式 | 接入入口 | 适合 |
|---|---|---|
| DSH 生态用户 | `dsh plugin --profile <name> add @dshrb/bundle` | 装进既有 profile，与其他插件共享 `ctx` |
| GitHub Action | workflow 里 `uses: dshrb/reviewer-action@v0.1.1` | 尝鲜、小仓库 |
| Daemon | 常驻 webhook 服务 | 大仓库、多仓库、私有部署 |

```bash
# DSH 生态用户：装进既有 profile，与其他插件共享 ctx
dsh plugin --profile web add @dshrb/bundle   # --profile 换成你的 profile 名

# GitHub Action：见 examples/review.yml
# Daemon：见 docs/08-deployment-modes.md
```

- GitHub Action 最小配置见 [`examples/review.yml`](./examples/review.yml)，命令触发见 [`examples/commands.yml`](./examples/commands.yml)
- Daemon 部署与完整模式对比见 [`docs/08-deployment-modes.md`](./docs/08-deployment-modes.md)

> 本地迭代命令 `dshrb review --local` / `dshrb replay <run-id>` 不构成独立安装方式，见 [部署形态](./docs/08-deployment-modes.md)。

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
packages/core/           领域类型与评审内核
  review-core            领域类型（零依赖、零 I/O，公共词汇表）
  forge                  ForgeGateway 接口 + provider 注册表
  trust-policy           四级信任判定 + 工具执行门禁
  rule-registry          规则包注册表（glob 匹配）
  review-runtime         八阶段评审管线编排
  progress               sticky 进度评论生命周期
  runtime-bootstrap      Cordis 容器 + 插件链 + agent loop 装配入口
packages/forge/          provider 实现（github / gitlab / local）
packages/tools/          模型可见评审工具（注册在 ctx.tools）
packages/rules/          评审规则包（baseline）
packages/drivers/        Action / Webhook / CLI 三种外壳
packages/probe/          上游签名探针（仅开发期验证契约）
bundle/                  dsh.bundle 声明，供 dsh plugin --profile <name> add
examples/                workflow 模板
scripts/                 包清单生成（gen-package-manifests.mjs 单一事实来源）
```

## 安全

- 凭据（forge token、DeepSeek API Key）在任何信任等级下都不进入 Agent 工作区
- 仓库内容、diff、评论、CI 日志、模型输出全部视为不可信数据
- 校验命令是 JSON argv 数组，不过 shell
- `.github/**`、`package.json` 的 `scripts`、二进制文件为 `ctx.tools.guard()` 永久红线，后续 listener 无法翻案
- 完整威胁清单见 [信任模型](./docs/04-trust-model.md)

发现安全问题请私下报告，勿开公开 issue。

## Star 历史

<a href="https://www.star-history.com/?repos=chaojixinren%2Fdsh-reviewer-bot&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=chaojixinren/dsh-reviewer-bot&type=date&theme=dark&legend=top-left&sealed_token=I6mGiUsP3J8qGlfTB1jOBHZ79XbZO6ffLQwc3rCVJhK9MgZDTIMb8VMm5adRF67Btc1-hBIZ-iu4MJ7DcQopmf80YjoCEEpMLybU_7FTCVIUnqSGGOzNFqhTAy2ZeCes0DAQRGneC0FO_hf2YcWls7-6nqGvWT4RR-dXBQX-Jukoc7DP1Ps4NG24oeXI" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=chaojixinren/dsh-reviewer-bot&type=date&legend=top-left&sealed_token=I6mGiUsP3J8qGlfTB1jOBHZ79XbZO6ffLQwc3rCVJhK9MgZDTIMb8VMm5adRF67Btc1-hBIZ-iu4MJ7DcQopmf80YjoCEEpMLybU_7FTCVIUnqSGGOzNFqhTAy2ZeCes0DAQRGneC0FO_hf2YcWls7-6nqGvWT4RR-dXBQX-Jukoc7DP1Ps4NG24oeXI" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=chaojixinren/dsh-reviewer-bot&type=date&legend=top-left&sealed_token=I6mGiUsP3J8qGlfTB1jOBHZ79XbZO6ffLQwc3rCVJhK9MgZDTIMb8VMm5adRF67Btc1-hBIZ-iu4MJ7DcQopmf80YjoCEEpMLybU_7FTCVIUnqSGGOzNFqhTAy2ZeCes0DAQRGneC0FO_hf2YcWls7-6nqGvWT4RR-dXBQX-Jukoc7DP1Ps4NG24oeXI" />
  </picture>
</a>

## 许可

MIT。非 DeepSeek 官方项目。
