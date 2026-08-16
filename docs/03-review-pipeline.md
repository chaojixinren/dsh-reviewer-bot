# 03 评审管线

## 八阶段管线

```mermaid
flowchart LR
    P1["1 Ingest<br/>事件归一"] --> P2["2 Route<br/>意图识别"]
    P2 --> P3["3 Authorize<br/>信任判定"]
    P3 --> P4["4 Context<br/>受限上下文装配"]
    P4 --> P5["5 Reason<br/>Agent 执行"]
    P5 --> P6["6 Validate<br/>提议校验"]
    P6 --> P7["7 Publish<br/>评论发布"]
    P7 --> P8["8 Mutate<br/>写操作（可选）"]
    P8 --> P9["9 Report<br/>结果 JSON"]
    P6 -.->|"校验失败"| P9
    P3 -.->|"denied"| P9
```

每个阶段是纯函数式的 `(input, deps) => Promise<output>`，阶段名进入 `result-json.failure.phase`，便于用户定位失败点。

## 阶段契约

| 阶段 | 输入 | 输出 | 失败语义 |
|---|---|---|---|
| Ingest | 平台原生 webhook / event payload | `NormalizedEvent` | `invalid_payload`，不可重试 |
| Route | `NormalizedEvent` | `ReviewIntent`（review/diagnose/fix/none） | 无匹配 → `neutral` 正常退出 |
| Authorize | `ReviewIntent` + actor 信息 | `TrustLevel` | `denied`，不可重试 |
| Context | 目标 SHA + 规则集 | `BoundedContext`（diff 切片 + 规则 + 记忆） | `context_overflow`，可重试（降级切片） |
| Reason | `BoundedContext` | `RawProposal[]`（不可信） | `model_error` / `timed_out`，可重试 |
| Validate | `RawProposal[]` | `Finding[]`（已锚定） | `validation_failed`，不可重试 |
| Publish | `Finding[]` | 评论 id 列表 + 统计 | `publish_partial`，可重试（幂等） |
| Mutate | `Patch[]` | commit sha / PR url | `write_rejected`，不可重试 |
| Report | 全阶段汇总 | `result-json` + scalar outputs | 永不失败（兜底写出） |

## 主流程时序（PR 自动评审）

```mermaid
sequenceDiagram
    autonumber
    participant F as Forge（GitHub 等）
    participant D as Driver
    participant R as review-runtime
    participant T as trust-policy
    participant P as progress
    participant A as DSH Agent
    participant V as validator

    F->>D: PR opened 事件
    D->>R: NormalizedEvent
    R->>R: Route → intent=review
    R->>T: authorize(actor, intent)
    T-->>R: TrustLevel=untrusted（fork PR）
    R->>P: 建 sticky 评论（stage=received）
    P->>F: POST comment（marker: summary）
    F-->>P: comment_id
    R->>R: 装配 BoundedContext（base SHA diff + 规则 + 记忆）
    R->>P: 更新 sticky（stage=reviewing）
    R->>A: 启动 Agent（工具白名单：仅只读评审工具）
    loop 每个 diff 切片
        A->>A: 读切片 → 匹配规则 → 提 finding
        A-->>R: session/event（进度 chunk）
        R->>P: 节流更新进度
    end
    A-->>R: RawProposal[]（不可信）
    R->>V: 校验
    V->>V: schema → 路径归一 → 锚定 diff 行 → 体积上限 → 去重
    V-->>R: Finding[] + 丢弃原因
    R->>F: 发行内评论（批量）
    R->>P: 更新 sticky（stage=done + 汇总）
    R->>D: result-json
    D->>F: 写 Action outputs
```

**注意第 7 步**：sticky 评论在**鉴权之后、上下文装配之前**建立。这样即使后续超时，用户也能看到「已收到、正在处理」而不是静默失败。配合 watchdog，超时路径同样会写出 outputs 并更新该评论。

## 写模式时序（`@dsr fix`）

```mermaid
sequenceDiagram
    autonumber
    participant U as 评审者
    participant F as Forge
    participant R as review-runtime
    participant T as trust-policy
    participant P as ctx.sandboxPolicy
    participant FS as ctx.fs
    participant SB as ctx.sandbox
    participant A as DSH Agent
    participant V as validator

    U->>F: 评论首行 `@dsr fix`
    F->>R: issue_comment 事件
    R->>T: authorize(actor=U, intent=fix)
    Note over T: 双重条件<br/>1 actor 有 write/maintain/admin<br/>2 配置显式 allow-write=true
    alt 任一不满足
        T-->>R: denied
        R->>F: 回帖说明缺哪个条件
    else 双重满足
        T-->>R: TrustLevel=trusted-write
        Note over R: driver 预置工作区：<br/>session cwd 是去 .git 的不可信副本
        R->>P: resolve(session) → SandboxExecutionPolicy
        Note over P: mode + workspaceRoot<br/>（cwd 即写边界）
        R->>A: 启动 Agent（工具白名单 + 写工具）
        A->>FS: writeText/editText(…, sandboxPolicy)
        Note over FS: 沙箱化 fs 后端按策略落界，<br/>裸后端忽略该参数
        A-->>R: Patch[]（不可信）
        R->>V: 校验补丁
        V->>V: 路径白名单 → 无二进制 → 无 .github/** → hunk 可 apply → 体积上限
        V-->>R: 通过的 Patch[]
        R->>FS: apply 补丁（落界内）
        R->>SB: confine(校验 argv, policy) → ConfinedArgv
        R->>R: spawn ConfinedArgv 跑校验命令（JSON argv，不过 shell）
        SB-->>R: 校验结果（含执行完整度与拒绝特征串）
        alt 校验失败
            R->>F: 报告失败 + 完整日志，不提交
        else 校验通过
            R->>R: 二次确认实际文件变更 ≠ 空
            R->>F: commit 到 PR 分支
            R->>F: 更新 sticky（marker: write）
        end
    end
```

**写模式隔离的三段式**（`ctx.sandbox` 不是隔离后端，见 docs/05）：

1. **策略解析** —— `ctx.sandboxPolicy.resolve(session)` 产出 `SandboxExecutionPolicy`（`mode` + `workspaceRoot`）。session cwd 即写边界；driver 负责把它指向去 `.git` 的不可信副本。
2. **文件写入** —— `ctx.fs.writeText / editText(…, sandboxPolicy)` 由沙箱化 fs 后端按策略拦界。
3. **子进程** —— `ctx.sandbox.confine(argv, policy)` 把精确 argv 包进受限执行，返回 `ConfinedArgv`（含执行完整度、拒绝特征串）；校验命令仍是 JSON argv、不过 shell。

「无网络」不在 `SandboxMode` 词汇表内：靠 Agent 不持网络工具 + 控制器代跑网络保证（docs/04）。可选 Docker 隔离是 driver 层实现（Action 模式容器镜像），不是 `ctx.sandbox`。

**写路径的硬红线**（`ctx.tools.guard()` 单调拒绝，后续 listener 无法翻案）：

- `.github/**`、`.gitlab-ci.yml`、任何 CI 配置 → 永久拒绝（防自我提权）
- `package.json` 的 `scripts` 字段 → 永久拒绝（防校验命令被改写）
- 任何二进制文件 → 永久拒绝
- lockfile → 仅在同一次变更也改了对应 manifest 时允许

## 意图路由表

| 触发 | intent | 最低信任 | 需 allow-write |
|---|---|---|---|
| PR opened / synchronize / ready_for_review | `review` | untrusted | 否 |
| `@dsr review` | `review` | untrusted | 否 |
| `@dsr explain <path>` | `explain` | untrusted | 否 |
| `@dsr diagnose` | `diagnose` | trusted-read | 否 |
| `@dsr fix` | `fix` | trusted-write | **是** |
| `@dsr rules` | `rules`（打印生效规则） | untrusted | 否 |
| `@dsr accept ["path","ruleId","title"] [原因]` | `accept`（记录已决议例外） | trusted-read | 否 |
| `@dsr forget ["path","ruleId","title"]` | `forget`（撤销已决议例外） | trusted-read | 否 |
| 其它 | `none` → neutral 退出 | — | — |

命令必须出现在评论**首行**，避免用户引用他人评论时误触发。

`accept` / `forget` 是跨 PR 记忆（docs/07）的写入口，不跑评审管线、不起 Agent：控制器解析首行的 JSON 身份（`path + ruleId + title`，即 `findingMemoryKey` 的组件）后调用 `ReviewMemory.recordResolved` / `forgetResolved`，失败阶段记作 `memory`。评审管线在 `validate` 之后、`publish` 之前用同一身份抑制命中例外——抑制是确定性控制器行为，不是 Agent 自觉。

## 状态机

```mermaid
stateDiagram-v2
    [*] --> Received
    Received --> Routed: 匹配到 intent
    Received --> Neutral: 无匹配
    Routed --> Authorized: 信任判定通过
    Routed --> Denied: 权限不足
    Authorized --> Contextualizing
    Contextualizing --> Reasoning
    Contextualizing --> Failed: 上下文溢出且降级失败
    Reasoning --> Validating
    Reasoning --> TimedOut: 超过 watchdog
    Validating --> Publishing
    Validating --> ValidationFailed: 全部提议被丢弃
    Publishing --> Mutating: intent=fix 且校验通过
    Publishing --> Success: 只读意图
    Mutating --> Success
    Mutating --> ValidationFailedW: 校验命令失败
    Success --> [*]
    Neutral --> [*]
    Denied --> [*]
    Failed --> [*]
    TimedOut --> [*]
    ValidationFailed --> [*]
    ValidationFailedW --> [*]
```

终态一律写出 `result-json`；`TimedOut` 由 watchdog 保证在 job 级超时之前落盘。

## 分片并行（差异化 B6）

```mermaid
flowchart TB
    D["PR diff"] --> S["切片器<br/>按模块/文件聚类"]
    S --> C1["切片 1"] & C2["切片 2"] & C3["切片 N"]
    C1 --> A1["subagent 1"]
    C2 --> A2["subagent 2"]
    C3 --> A3["subagent N"]
    A1 & A2 & A3 --> M["合并器<br/>去重 · 严重度排序 · 全局一致性复核"]
    M --> V["统一校验"]
```

切片策略：优先按 import 图聚类保持语义完整，单切片超上限则按 hunk 硬切并标注「上下文被截断」，避免模型对残缺代码下强判断。合并器负责跨切片去重（同一 finding 在多个切片重复提出）与全局问题识别（如接口两侧不一致）。
