# 维护指南

## 模块职责

- `packages/contracts` 定义跨模块数据结构、Zod 校验 schema 和基础运行时接口。
- `packages/world` 汇总观测并维护只读世界快照。
- `packages/planner` 根据快照生成路径和依赖信息。
- `packages/controller` 管理控制权租约，并将输入交给客户端驱动。
- `packages/decision` 管理目标、任务依赖、任务执行和候选任务排序。
- `packages/llm` 定义模型请求契约、限制上下文，并协调可取消的计划请求。
- `packages/memory` 持久化事件与事实；`packages/replay` 记录并重放事件。
- `packages/plugins` 校验插件清单。
- `apps/bot` 组装上述模块，提供离线演示、在线命令入口、配置和首批技能。

核心包的 `src/index.ts` 是兼容入口。实现按职责放在同目录的具名文件中，调用方继续从 `index.js` 导入公开 API。

## 修改约定

优先将新逻辑放在所属职责文件中，并从该包的入口重新导出。跨包共享的结构放入 contracts；不要为了复用单个调用点建立额外抽象。注释用于解释边界、约束或非显然决策，避免复述代码本身。新增命令或架构约定时同步更新本指南。

## 格式与检查

仓库使用 Prettier 3.6.2，规则固定在 `.prettierrc.json`。格式化整个代码、测试、脚本和根配置：

```sh
pnpm format
```

只检查格式：

```sh
pnpm format:check
```

提交前运行：

```sh
pnpm typecheck
pnpm test
```

## 模型与回放边界

从仓库根目录使用 Node 24 的 `--env-file-if-exists=.env` 显式加载配置；`LLM_PROVIDER=offline` 为默认值，显式选择远端时必须配置地址、密钥和模型。配置不会隐式搜索环境文件。不要在日志中写认证信息、完整请求或远端错误正文。模型建议不拥有任务资源、优先级、抢占或成功谓词的权限；技能目录派生这些规则，运行时根据实际观测确认目标。

`NdjsonRecorder.appendEvent` 接收调用方生成的完整事件，序号必须严格递增，时间必须单调；不要与自动编号的 `append` 混用。队列满时返回 `false`，调用方须记录故障或在保持顺序的前提下等待并重试。存在缺失事件时不能声称回放完整。`replayDecision` 只消费已记录事件并重建状态，重新校验模型响应和任务结构，不调用真实 Provider 或技能；`recomputeDeterministically` 是独立的确定性重算工具，不能用状态重建代替真实动作验收。

真实模型 API 与 Paper 在线动作需要独立执行和记录验证；模拟 HTTP 或离线夹具不能替代这两项验收。
