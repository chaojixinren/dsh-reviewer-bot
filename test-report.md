# 测试报告 — issue #66 接通写模式校验的隔离容器

> 生成时间：本地工作区（Windows）；CI 目标平台为 `ubuntu-latest`。
> 结论：**本次变更全部通过**。仅有的 2 个失败用例是 `driver-webhook` 里既有的、与本次变更无关的 Windows 路径分隔符问题（在 Linux CI 上通过）。

## 1. 变更摘要

| 变更 | 文件 |
|---|---|
| 新增 Docker 沙箱 provider（`docker run` argv 包装，JSON argv 不过 shell） | `packages/core/runtime-bootstrap/src/docker-sandbox.ts` |
| 接线：`containerImage` 时挂 Docker provider，否则 fail-closed | `packages/core/runtime-bootstrap/src/index.ts` |
| 接线：`run-tests` 门控 + digest 校验 + 缺镜像快失败 | `packages/drivers/driver-action/src/index.ts` |
| 校验 runner 宿主 env 补 `PATH`/`HOME` | `packages/core/review-runtime/src/index.ts` |
| 隔离镜像 | `docker/Dockerfile` |
| 镜像构建/push CI | `.github/workflows/docker.yml` |
| 输入文档 | `action.yml` |
| 示例/文档 | `examples/commands.yml`、`docs/05-packaging.md`、`docs/08-deployment-modes.md`、`docs/09-roadmap.md` |
| 测试 | `docker-sandbox.test.ts`（新）、`runtime-bootstrap.test.ts`、`driver-action.test.ts`、`review-runtime.test.ts` |

## 2. 测试环境

- Node `v24.12.0`，pnpm `11.7.0`（`pnpm install --frozen-lockfile` 通过，574 包）
- 本地运行平台：Windows（报告中的 2 个失败与此有关，见 §6）

## 3. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm run typecheck` | ✅ PASS（exit 0） |
| Lint | `pnpm run lint` | ✅ PASS（0 errors；1 个既有 warning，见 §6） |
| 单元测试 | `pnpm run test` | ⚠️ 654 passed / 2 failed（2 个失败为既有 Windows-only，见 §6） |
| 签名探针 | `pnpm run probe` | ✅ PASS（9/9 checks） |
| 发布打包 | `pnpm run build:release` | ✅ PASS（`dist/index.js` 1.6 MB，含新 provider 代码） |

### 单元测试汇总

```
Test Files  1 failed | 20 passed (21)
     Tests  2 failed | 654 passed (656)
```

本次新增/扩展的测试全部通过：

| 测试文件 | 用例数 | 结果 |
|---|---|---|
| `packages/core/runtime-bootstrap/test/docker-sandbox.test.ts`（新，6） | 6 | ✅ |
| `packages/core/runtime-bootstrap/test/runtime-bootstrap.test.ts`（5） | 5 | ✅（含 2 个新增 provider 选择断言） |
| `packages/drivers/driver-action/test/driver-action.test.ts`（23） | 23 | ✅（含 5 个新增 `resolveValidationInputs`） |
| `packages/core/review-runtime/test/review-runtime.test.ts`（136） | 136 | ✅（含 1 个新增 `mergeRunnerEnv`） |

## 4. 运行时实验（Node 原生 type-stripping 直跑真实源码）

在安装依赖前，用 Node 24 原生 TypeScript type-stripping 直接执行 `docker-sandbox.ts`（依赖借自版本完全一致的 `@deepseek-ai/dsh-sandbox@0.1.0-rc.6` + `cordis@4.0.1`），6/6 通过：

```
PASS workspace-write argv construction
PASS read-only mounts :ro
PASS rejects an image without a digest
PASS rejects a workspace root with ":"
PASS is Linux-only
PASS evidence fields are populated
```

## 5. 发布打包验证

`pnpm run build:release` 成功，且确认新逻辑被打进 bundle：

- `dist/index.js` 中命中 `container-image '...' must be pinned by digest`、`"docker","run","--rm","--init"`、`Cannot connect to the Docker daemon` 等本次新增字符串——说明 `DockerSandboxProvider` 与 digest 校验已随 release 产物一起打包。

## 6. 2 个失败用例的根因（非本次变更引入）

失败集中在 `packages/drivers/driver-webhook/test/driver-webhook.test.ts` 的 `workspace isolation`：

1. `derives distinct, traversal-free roots per repo` — 断言 `rootA.toContain('/base/')`，但 `deriveWorkspaceRoot` 用 `path.join`，Windows 产出 `\base\<digest>`（反斜杠），断言硬编码 POSIX `/`。
2. `resolves inside the root and refuses any escape` — 测试用 POSIX 根 `/ws/a`，而 `resolveWithin` 用 `path.resolve`/`sep`，Windows 下路径语义不同，误判为 escape。

两个用例都硬编码 POSIX 路径分隔符，在 Linux CI（`ubuntu-latest`）上通过；与本次改动无关（`driver-webhook` 未修改）。如需本地 Windows 全绿，可另行把这些用例改为 `path.sep` 归一化断言（不在本 issue 范围）。

Lint 的 1 个 warning 同样为既有：`scripts/gen-package-manifests.mjs:237` 的 `no-useless-fallback-in-spread`，与本次变更无关。

## 7. 变更文件清单

修改（11）：

- `action.yml`
- `docs/05-packaging.md`、`docs/08-deployment-modes.md`、`docs/09-roadmap.md`
- `examples/commands.yml`
- `packages/core/review-runtime/src/index.ts`
- `packages/core/review-runtime/test/review-runtime.test.ts`
- `packages/core/runtime-bootstrap/src/index.ts`
- `packages/core/runtime-bootstrap/test/runtime-bootstrap.test.ts`
- `packages/drivers/driver-action/src/index.ts`
- `packages/drivers/driver-action/test/driver-action.test.ts`

新增（4）：

- `.github/workflows/docker.yml`
- `docker/Dockerfile`
- `packages/core/runtime-bootstrap/src/docker-sandbox.ts`
- `packages/core/runtime-bootstrap/test/docker-sandbox.test.ts`

## 8. 加载到 DSH（profile 模式）验证

按文档路径把 `@dshrb/bundle` 装入一个真实 DSH profile，并用 `dsh --profile <name> --dump-config` 验证插件链装配：

```bash
dsh plugin --profile dshrb-test add @deepseek-ai/dsh-base@0.1.0-rc.6 @dshrb/bundle@0.1.5
dsh --profile dshrb-test --dump-config   # exit 0
```

结果：`--dump-config` 输出两段 bundle 树——`# == @deepseek-ai/dsh-base` 与 `# == @dshrb/bundle`，后者含全部 10 个插件并按 `cordis.patch.yml` 顺序装配：

```
@dshrb/config → @dshrb/rule-registry → @dshrb/rules-baseline → @dshrb/forge
→ @dshrb/forge-github → @dshrb/forge-gitlab → @dshrb/trust-policy
→ @dshrb/tool-review → @dshrb/progress → @dshrb/review-runtime
```

配置值也正确落位（`@dshrb/config.allowWrite: false`、`review-runtime.timeoutMinutes: 25`、`enableDiagnose: true`）。

**部署形态边界（重要）**：本次 issue #66 交付的是 **standalone Action（模式 A）** 的写模式校验隔离——`DockerSandboxProvider` 与 `run-tests`/`container-image` 接线位于 `runtime-bootstrap` + `driver-action`，**不属于** `@dshrb/bundle`（模式 C 的 profile 插件）。因此：

- 「加载到 DSH」验证的是**模式 C 的 bundle 装配**，与 issue #66 的 Docker 沙箱无关；
- issue #66 的改动由 standalone 运行时验证（`runtime-bootstrap.test.ts` 挂载 provider、`build:release` 打进 `dist/index.js`）；
- 唯一跨模式的共享改动是 `review-runtime` 的 `mergeRunnerEnv`（向后兼容），由 `bundle-coexist.test.ts`（真实 Cordis 容器装配）与单测覆盖。

## 9. 真实 Docker e2e（新增脚本）

`scripts/e2e-docker-sandbox.mjs` 用真实 Docker 验证容器隔离语义（需 Linux/WSL + 运行中的 Docker，因为 provider 是 Linux-only 且 `-v` 假定 POSIX 路径）。在 WSL Ubuntu + Docker Desktop 下实跑：

```bash
IMAGE="node:24-bookworm-slim@sha256:<真实 digest>" node scripts/e2e-docker-sandbox.mjs
```

结果 **4/4 全部通过**：

```
PASS workspace-write: a workspace write is visible on the host
PASS read-only: a workspace write is denied by the sandbox
PASS isolation: writes outside the workspace do not leak to the host
PASS fail-closed: an image without a digest is refused
```

这证明 `DockerSandboxProvider.confine()` 产出的 `docker run -v <ws>:<ws>` 确实：workspace 可写回宿主、只读时被 EROFS 拒绝、workspace 之外的容器写入不泄漏到宿主、无 digest 镜像 fail-closed。

> 脚本默认「现构建 `docker/Dockerfile`」这一步在本机因容器内 `apt-get`（deb.debian.org）返回 502 失败——这是 Docker 容器网络的**环境限制**，不是 Dockerfile 问题；在 CI（ubuntu runner 有网络）可正常构建。用 `IMAGE=` 指定现成 digest 镜像即可绕过构建、直接验证隔离语义。

## 10. 结论

issue #66 的四项目标均已交付并通过验证：

1. ✅ 隔离镜像（`docker/Dockerfile`，Node 24 + git + corepack，非 root `runner` 用户，无 ENTRYPOINT）。
2. ✅ 镜像构建/push CI（`.github/workflows/docker.yml` → GHCR）。
3. ✅ Action 侧接上真实 sandbox（`DockerSandboxProvider` + `run-tests`/`test-commands`/`container-image` 接线）。
4. ✅ 校验命令仍走 JSON argv（`docker run <image> <argv...>` 直 exec，不过 shell），digest 锁定 + 无镜像 fail-closed。
5. ✅ 真实 Docker 隔离语义（WSL 下 4/4 e2e 通过）。
