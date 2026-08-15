# 贡献指南

感谢你考虑为 DSH Reviewer Bot 贡献代码。这份指南说明如何搭建环境、遵循哪些约定、如何提交改动。若有与代码不一致的地方，以代码和 `docs/` 为准，并欢迎顺手修正这份文档。

## 当前阶段

项目处于 **M2（规则与本地化）已完成** 阶段：M1 只读评审闭环已全部落地（`review-core` 领域类型、forge 接口/注册表 + 锚定器、`trust-policy` 信任判定、`forge-github` provider、`tool-review` 只读工具、`review-runtime` 八阶段管线、`progress` sticky 上报、`driver-action`）。M2 交付规则注册与本地反馈闭环：`rule-registry` + `rules-baseline` 让规则变成可注册、可审计的数据，`forge-local` 提供本地 git provider 支撑离线 dry-run，`driver-cli`（`review --local` / `replay` / `rules --explain` / `doctor`）提供本地反馈闭环——调规则、调提示词不必推 PR 等 CI。M3 写模式已开始：`diagnose` 意图（读 CI 失败日志定位根因并回帖）已落地，`mutate` / `propose_patch` 等写路径仍在推进。

动手前请先读：

- [`docs/README.md`](./docs/README.md) —— 设计文档索引与 5 条设计原则
- [`docs/09-roadmap.md`](./docs/09-roadmap.md) —— 里程碑、验收标准、风险登记与「当前状态」

正在进行的任务以 roadmap 的 **M3 验收标准**为准，欢迎从「当前状态 → 未实现（刻意）」清单里认领。认领前建议先开 issue 说明意图，避免重复劳动。

## 环境与快速开始

| 依赖 | 版本 |
|---|---|
| Node | 22.19+ / 24+（26 亦可） |
| pnpm | 11.x（仓库锁定 `11.7.0`） |

```bash
pnpm install
pnpm run check    # typecheck + lint + test，全绿才可提交
```

常用脚本（定义见根 `package.json`）：

| 命令 | 作用 |
|---|---|
| `pnpm run typecheck` | `tsc -b`，全量类型检查（project references） |
| `pnpm run lint` | `oxlint .` 静态检查 |
| `pnpm run test` | `vitest run`（`test:watch` 为交互式） |
| `pnpm run probe` | 运行 `@dshrb/signature-probe`，在真实 Cordis 容器验证上游扩展点契约 |
| `pnpm run clean` | 删除各包 `lib/` 构建产物 |

## 仓库结构

```
docs/                    设计文档（mermaid），改设计先改这里
packages/core/           领域类型与评审内核
  review-core            领域类型（零依赖、零 I/O，一切包的公共词汇表）
  forge                  ForgeGateway 能力接口 + provider 注册表
  trust-policy           四级信任判定与工具执行门禁
  rule-registry          规则包注册表（glob 匹配）
  review-runtime         八阶段评审管线编排
  progress               sticky 进度评论生命周期
packages/forge/          代码平台 provider（github / gitlab）
packages/tools/          模型可见评审工具（注册在 ctx.tools）
packages/rules/          评审规则包（baseline）
packages/drivers/        运行形态外壳（action / webhook / cli）
packages/probe/          上游签名探针（不参与运行时，只在开发期验证契约）
bundle/                  dsh.bundle 声明，供 `dsh plugin add`
examples/                workflow 模板
scripts/                 gen-package-manifests.mjs（包清单单一事实来源）
```

依赖方向是单向的：`review-core` 不依赖任何 forge/模型/传输，其他包依赖它；领域类型只声明「评审是什么」，从不决定「怎么取、怎么发」。

## 开发流程

### 按改动类型

| 想做的事 | 去哪改 |
|---|---|
| 新增/调整领域类型、契约 | `packages/core/review-core`，同步更新 `docs/07-data-contracts.md` |
| 接入新代码平台 | `packages/forge/*`，按 [docs/06-forge-abstraction.md](./docs/06-forge-abstraction.md) 的 provider 清单 |
| 新增评审规则 | `packages/rules/*`，并在 `rule-registry` 注册 |
| 新增模型可见工具 | `packages/tools/*`，通过 `ctx.tools.register()` |
| 新增运行形态 | `packages/drivers/*`，只写驱动壳，不写第二套业务逻辑 |
| 新插件包 | 见「新增一个包」 |

### 新增一个包

1. 在 [`scripts/gen-package-manifests.mjs`](./scripts/gen-package-manifests.mjs) 的 `PACKAGES` 表加一行（目录、短名、描述、workspace 依赖）。
2. 若插件注入了上游服务（如 `tools`、`systemPrompt`），在 `UPSTREAM` 表登记其所有者包——`peerDependencies` 只指向「拥有所注入服务的那个 `dsh-*` 包」，而不是 `@deepseek-ai/dsh` 全家桶。
3. 运行 `node scripts/gen-package-manifests.mjs` 生成该包的 `package.json` 与 `tsconfig.json`。
4. 在根 [`tsconfig.json`](./tsconfig.json) 的 `references` 里加一项。
5. `pnpm install` 后跑 `pnpm run check`。

不要手改各包的 `package.json` / `tsconfig.json`——它们由脚本生成，手改会漂移。

### 升级上游版本

DSH 处于 developer preview，rc 之间可能有破坏性变更，因此**一律精确锁定、不写 range、不写 `*`**。单一事实来源是 [`scripts/gen-package-manifests.mjs`](./scripts/gen-package-manifests.mjs) 顶部的 `CORDIS` / `SCHEMASTERY` / `DSH` 三个常量。

升级流程：

1. 改常量 → `node scripts/gen-package-manifests.mjs` → `pnpm install`。
2. **必跑 `pnpm run probe`**：它 typecheck 并真实加载 4 个扩展点 + 写模式三缝契约，签名变了会在这里失败，而不是在生产里静默失败。
3. 更新 [`docs/09-roadmap.md`](./docs/09-roadmap.md) 的兼容矩阵。

策略：跟随上游 rc 但不追最新，滞后一个 rc 以规避回归。

### 新增 forge provider

按 [`docs/06-forge-abstraction.md`](./docs/06-forge-abstraction.md) 的完整清单：

1. 至少实现 `DiffSource` + `CommentSink` + `ActorResolver` 能力接口。
2. 填写能力矩阵与概念归一表（注意 GitLab 的 `iid`/`id` 不可混用）。
3. 提供该平台的 webhook 签名校验。
4. 通过 `packages/core/forge` 导出的 provider 契约测试套件（多 provider 行为一致性的强制门禁）。
5. 声明 `dsh.bundle` 独立发布。

## 编码约定

### 类型与风格

- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`（见 [`tsconfig.base.json`](./tsconfig.base.json)），不放松这些开关。
- 标识符用品牌类型（`Brand<string, 'FindingId'>`）区分语义，禁止裸字符串互相赋值。
- 模型输出先落成宽松的 `RawProposal`（全可选、无品牌），**必须过校验器才能消费**——不直接信任模型字段。

### 信任模型红线（不可违反）

- 凭据（forge token、DeepSeek API Key）在任何信任等级下都**不进入 Agent 工作区**。
- 仓库内容、diff、评论、CI 日志、模型输出全部视为**不可信数据**。
- 校验命令是 **JSON argv 数组，不过 shell**。
- `.github/**`、`package.json` 的 `scripts`、二进制文件是 `ctx.tools.guard()` 的**永久红线**，后续 listener 无法翻案。
- 完整威胁清单见 [`docs/04-trust-model.md`](./docs/04-trust-model.md)。

### 设计原则

见 [`docs/README.md`](./docs/README.md)，其中两条直接影响怎么写代码：

- **确定性外壳包裹非确定性内核**：路由、鉴权、发布、校验是纯确定性代码，必须可单测；只有「读懂这段 diff」交给模型。
- **模型只提议，控制器才决定**：落地为评论/commit/PR 前，必须过 schema 校验、路径归一化、diff 行锚定、体积上限。

### 测试

- 用 vitest，测试文件放在包内 `test/` 目录（如 `packages/core/forge/test/forge-registry.test.ts`）。
- 确定性逻辑（注册表、信任判定、锚定器、校验）优先写纯函数单测，**不依赖网络/凭据/DSH 运行时**。
- 改 forge provider 必须过共享契约测试套件；锚定器与信任门禁要有高覆盖负向测试（见 roadmap 各里程碑验收标准）。

## 提交与 PR

### 提交信息

遵循 [Conventional Commits](https://www.conventionalcommits.org/)，格式 `type(scope): 描述`。描述用中文、陈述做了什么（与现有历史一致）。scope 用包短名或区域。

```
feat(forge-github): 实现 DiffSource 与行内评论锚定
fix(trust-policy): fork PR 判定为 untrusted 后不再暴露读工具
test(forge): 补 provider 注册/卸载与能力缺失路径
docs: 更新 M1 验收进度
chore: 锁定上游 rc.7 并重跑签名探针
```

类型：`feat` / `fix` / `docs` / `test` / `chore` / `refactor`。

### 提交流程

1. 从 `main` 拉出功能分支（`feat/...`、`fix/...`），提交后推分支开 PR。
2. PR 描述写明「改了什么、为什么、怎么验证」，涉及契约/信任模型的改动引用对应 docs。
3. CI（[`.github/workflows/ci.yml`](./.github/workflows/ci.yml)）以 `pnpm install --frozen-lockfile` + `pnpm run check` 为门禁；本地先跑通再推。
4. 与里程碑验收标准相关的改动，在 PR 里勾选/说明对应条目。

## 安全

发现安全问题时**请私下报告，勿开公开 issue**。涉及信任模型、写模式、沙箱落界、凭据处理的改动会被重点审查。

## 许可

MIT。非 DeepSeek 官方项目。
