# 05 打包：runtime bootstrap 与 release build

> 本文档说明「如何把 Cordis 容器 + 插件链 + LLM agent loop 组装成一个可执行入口，并把它打包成 GitHub Action 的 `dist/index.js`」。它与 [05-plugin-composition.md](./05-plugin-composition.md) 互补：那篇讲**每个功能落到哪个 Cordis 扩展点**，这篇讲**这些插件如何被一个进程自己 boot 起来、再被 esbuild 折进单个文件**。

## 为什么不能走 DSH 官方 Launcher

DSH 的 profile 模式（docs/08 模式 C）由 `@deepseek-ai/dsh-app-boot` 的 `boot()` 用 Cordis Loader 按 `cordis.patch.yml` 解析插件，裸 specifier 解析依赖原生模块 `node-addon-require-builtin`：

- 原生模块**无法被 esbuild 打包**；
- Action 运行时 `using: node24` 只执行 `main:` 指向的一个 JS 文件，**不会** `npm install`。

因此 standalone Action **不经过** `dsh-app-boot`，而是由 `@dshrb/runtime-bootstrap` 直接 `ctx.plugin()` 装配。两种模式装配的是**同一批插件**，只是驱动方式不同：

| | profile 模式（C） | standalone 模式（A） |
|---|---|---|
| 装配描述 | `bundle/cordis.patch.yml` | `@dshrb/runtime-bootstrap` 的静态 import |
| boot 入口 | `dsh-app-boot` + Loader | `new Context()` + `await ctx.plugin(...)` |
| 裸 specifier 解析 | `node-addon-require-builtin` | 不需要（全部静态 import） |
| 产物 | 由 `dsh` 运行时加载 | esbuild 单文件 `dist/index.js` |

## runtime bootstrap 的装配顺序

`bootReviewRuntime(config)` 依**依赖顺序**挂载 ~16 个 DSH 运行时服务 + 9 个 `@dshrb` 插件：

```
DSH 运行时服务（service ← 提供者）
  systemPrompt  ← dsh-system-prompt
  tools         ← dsh-tools            (inject systemPrompt)
  sandboxPolicy ← dsh-sandbox-policy   (inject systemPrompt)
  fs            ← dsh-fs-sandbox       (inject sandboxPolicy)
  sandbox       ← UnavailableSandboxProvider（见下）
  typert        ← dsh-typert-registry
  sessions      ← dsh-session          (inject typert)
  agents        ← dsh-agent            (inject typert)
  sessionProjections ← dsh-session-projection
  subagents     ← dsh-subagent         (inject agents, sessionProjections)
  （provider）    ← dsh-subagent-spawn-in-process (inject subagents)
  agentDefaultModel ← dsh-agent-default-model
  llm           ← dsh-llm
  （adapter）     ← dsh-llm-deepseek    (inject llm, provides 'deepseek-official')
  credentials   ← dsh-credentials-local
  settings      ← dsh-settings-file

@dshrb 插件链（bundle/cordis.patch.yml 同序）
  rule-registry → rules-baseline → trust-policy → forge
  → forge-github（有 token 才挂）→ forge-gitlab（有 token 才挂）
  → tool-review → progress → review-runtime
```

`review-runtime` 挂载后即提供 `ctx.reviewRuntime.runReview(raw)`；`bootReviewRuntime` 再把 `runReview` 与 `createRunAgent(ctx, {forges, trustPolicy})` 暴露给 driver。凭据仍由环境继承（`DEEPSEEK_API_KEY` 由 driver-action 在 boot 前写入 `process.env`），**永不进入 agent 工作区**。

## 无法打包的原生依赖与 fail-closed 沙箱

DSH 本地沙箱 `dsh-sandbox-local` 用原生 launcher 包裹子进程（Linux 的 `bwrap`/Landlock、Windows 的 restricted-token runner），依赖 `node-addon-landlock-run` 与 `koffi`，**无法 esbuild 折进单文件**。但只读评审 / 诊断从不 confine 子进程，所以 standalone bundle 缺省挂一个 fail-closed 的 `UnavailableSandboxProvider`：

- 满足 `review-runtime` 对 `sandbox` 服务的 `inject` 依赖；
- 一旦被调用（写模式校验）就抛 `SandboxUnavailableError` —— 与 DSH「拒绝裸跑命令」的语义一致。

**写模式校验的交付**：当 driver 提供了 digest 锁定的 `container-image` 时，standalone bundle 改挂 `DockerSandboxProvider`（`packages/core/runtime-bootstrap/src/docker-sandbox.ts`）。它把校验命令重写为

```
docker run --rm --init -w <workspaceRoot> -v <workspaceRoot>:<workspaceRoot>[:ro] <image> <argv...>
```

- 校验命令仍是**JSON argv 直 exec**，`docker run` 后接的 argv 不经 shell，保住 docs/09 M3「不过 shell」红线；
- 隔离是**文件效应级**的：容器自身文件系统 ephemeral，只有 `workspaceRoot` 从宿主 bind-mount（`workspace-write` 可写、`read-only` 只读）；网络不在 `SandboxMode` 词汇表内，不在此处限制；
- 镜像必须按 digest 锁定（`@sha256:<64 hex>`），否则 `confine` fail-closed；Docker 守护进程不可用 / 镜像拉取失败时，`runnerFailureRules` 把失败归类为 runner-failed（命令从未运行），校验失败不 commit；
- 隔离镜像由 `docker/Dockerfile` 构建、`.github/workflows/docker.yml` 推送到 GHCR（`ghcr.io/<owner>/<repo>`）。

`dsh-fs-sandbox` → `dsh-fs-local` 对 `koffi` 是**惰性** `import("koffi")` 且仅 Windows 原子替换路径触发，Linux Action 上永不加载；打包时把 `koffi` 标 `external`，动态 import 原样保留。

## release build

`scripts/build-release.mjs` 用 esbuild 把 `driver-action/src/entry.ts` 折进 `dist/index.js`：

- `format: 'cjs'`：仓库根是 `"type": "module"`，`dist/` 自带 `package.json`（`{"type":"commonjs"}`）。CJS 规避了 CJS 依赖（如 `yaml`）在 ESM 输出里的 `Dynamic require ... not supported` 互操作 shim；
- `external: ['koffi']`：唯一需要保留的原生惰性 import；
- `import.meta.url` → banner 里的文件 URL 别名：部分 DSH 包用 `createRequire(import.meta.url)` 读自身 `package.json` 版本拼 User-Agent，CJS 下无 `import.meta`，别名指向 bundle 自身；
- 入口 `entry.ts` 在 `main()` settle 后**显式 `process.exit()`**：Cordis 运行时在 settle 后仍持有定时器/句柄，一次性 Action 进程不应等它们。

产物 `dist/` 被 `.gitignore` 忽略，由 release CI 构建并 attach 到 GitHub Release（不提交进源码树）。

## release CI

`.github/workflows/release.yml` 在打 tag（`v*`）时：

1. `pnpm install --frozen-lockfile`；
2. `pnpm run check` + `pnpm run probe`；
3. `pnpm run build:release` 产出 `dist/index.js`；
4. 把 `dist/index.js`（+ sourcemap）attach 到对应 Release。

`action.yml` 的 `main: dist/index.js` 由 release 产物提供，源码树不再残留 `TODO(M1)`。
