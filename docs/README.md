# DSH Reviewer Bot 设计文档

> 状态：设计阶段（脚手架已就位，业务代码未实现）
> 目标形态：**DSH 原生插件集** + 可选的 GitHub Action / Webhook 守护进程外壳

## 一句话定位

把代码评审做成 [DeepSeek Harness](https://dshfind.com/zh/plugins/deepseek-ai/deepseek-harness) 生态里的**一等公民插件**，而不是把 DSH 当黑盒子进程调用的一层 CI 胶水。

## 文档索引

| 文档 | 内容 |
|---|---|
| [01-design-goals.md](./01-design-goals.md) | 产品定位、安全基线、设计赌注 B1–B8 |
| [02-architecture.md](./02-architecture.md) | 系统总览、包拓扑、C4 式分层图 |
| [03-review-pipeline.md](./03-review-pipeline.md) | 事件 → 评审 → 发布 的完整时序与状态机 |
| [04-trust-model.md](./04-trust-model.md) | 四级信任模型、能力矩阵、威胁清单 |
| [05-plugin-composition.md](./05-plugin-composition.md) | Cordis 扩展点映射、bundle/profile 装配 |
| [06-forge-abstraction.md](./06-forge-abstraction.md) | 多代码平台抽象（GitHub / GitLab / Gitea） |
| [07-data-contracts.md](./07-data-contracts.md) | Finding / Verdict / result-json 契约与版本化 |
| [08-deployment-modes.md](./08-deployment-modes.md) | Action / Daemon / CLI 三种运行形态 |
| [09-roadmap.md](./09-roadmap.md) | 里程碑与验收标准 |

## 设计原则

1. **一切皆插件。** 遵循 DSH 的 `万物皆插件` 哲学：评审规则、代码平台、发布渠道、信任策略全部是可替换的 Cordis 插件，注册即生效、卸载即回滚（`ctx.effect`）。
2. **模型只提议，控制器才决定。** 模型输出永远是不可信数据。落地为评论、commit、PR 之前，必须过 schema 校验、路径归一化、diff 行锚定、体积上限。
3. **确定性外壳包裹非确定性内核。** 路由、鉴权、发布、校验是纯确定性代码，可单测；只有"读懂这段 diff"交给模型。
4. **凭据永不进入 Agent 工作区。** GitHub token 与 DeepSeek API Key 只由控制器持有，worker 侧通过代理注入。
5. **本地可复现。** 任何一次线上评审都能用 `dshrb replay <run-id>` 在本地离线重放，用于调 prompt 与规则而不必反复触发 CI。

## 与上游 DSH 的关系

我们不 fork DSH，只消费其公开扩展点：

```
ctx.tools.register()      注册模型可见的评审工具
ctx.on('tools/pre-execute') 信任门禁（allow / deny / ask）
ctx.tools.guard()         单调终局拒绝（写模式硬红线）
ctx.on('session/event')   进度上报（sticky comment 三阶段）
ctx.systemPrompt.section() 注入评审准则与仓库约定
ctx.agents / ctx.sessions  会话生命周期
ctx.sandboxPolicy + ctx.fs 写模式落界（策略解析 + 文件写入）
ctx.sandbox.confine()      校验子进程 argv 包裹
ctx.subagents             大 PR 分片并行评审
```

版本策略：DSH 处于 developer preview，破坏性变更频繁。我们对 `@deepseek-ai/dsh-*` 一律 pin 精确版本，并在 `docs/09-roadmap.md` 记录已验证的兼容区间。
