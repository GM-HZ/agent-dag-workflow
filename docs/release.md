# 发布与升级

## 1.1.0

- DSH Canvas 首页可以打开最近草稿、恢复个人运行、运行收藏的固定修订并核对定时试跑。失败摘要直达出错节点和对应 Journal 事件。[DSH / Canvas 指南](./guide/dsh)
- CLI 可创建订单整理项目、检查工作目录和存储、查看最近运行、安装项目级 Codex Skill。CLI 和 MCP 可以使用同一项目配置读取同一批模板与运行。[快速开始](./guide/quickstart) · [Codex / Skill 指南](./guide/codex)
- 运行轨迹可以完整导出为 JSONL，也可以导出带完整性校验的脱敏证据包。从失败运行生成回归样本后，可以比较基线和候选修订。[运行运维](./operations) · [订单整理示例](./examples/order-normalization)
- Cron 支持时区、错过调度处理和执行重叠策略。Canvas 可以试跑绑定的输入与修订，试跑保持正式调度游标。[定时任务](./operations#个人定时任务)

### 从 1.0.2 升级

**SQLite。** 首次打开现有数据库时会自动完成 `v11 → v12` 迁移。切换前先停止写入该数据库的 DSH 或 Runner，再用 `1.1.0` 的 CLI 对实际使用的数据库创建并验证快照。对于 DSH，使用插件配置中的数据库路径。

```bash
adw backup workflow-v11.snapshot.db --db /path/to/workflow.db
adw backup-verify workflow-v11.snapshot.db
```

确认快照的 `schemaVersion` 为 `11`、`integrity` 为 `ok` 后再启动新版。回退时先停写，用 `1.1.0` 的 CLI 将升级前的快照恢复到新文件，再让 `1.0.2` 指向恢复库。新版运行的数据仍保留在原来的 `v12` 库中。

```bash
adw restore workflow-v11.snapshot.db --db workflow-rollback.db
```

**Generic Webhook。** 发送方与接收方须在同一切换窗口升级。`x-workflow-signature` 使用 `v1=` 前缀，签名包含时间戳、事件 ID 和 HTTP 原始请求体。升级后旧签名会被拒绝。重试时保留相同事件 ID 和绑定修订，以延续去重。[签名格式与发送示例](./operations#generic-webhook-签名)

**自定义 Canvas / DSH。** `operations()` 返回绑定、入口与投递摘要，移除了原始绑定配置、入口 Envelope 和投递载荷。自定义 Canvas 绑定适配器需要提供 `get(id, revision)`，自定义 DSH `DagWorkflowEngineService` 需要实现 `validate(template, inputs, parent)`。官方 Bundle 已提供这些能力。

## 正式发布流程

CI 和 npm 发布流程共用原生 DSH 门禁，覆盖 `0.2.0-rc.2` 和 `0.2.2-rc.5`。`0.2.3-alpha.2` 是预览兼容版本。原生门禁通过 Chromium 操作安装了本次 npm tarball 的 DSH Canvas，检查示例运行、会话隔离、历史记录、JSONL 与 SQLite Journal 的一致性，以及脱敏证据包。

```bash
pnpm install --frozen-lockfile
pnpm check
node examples/run-codex-examples.mjs
pnpm verify:upgrade
pnpm exec playwright-cli install-browser chromium
pnpm verify:canvas-browser
AGENT_DAG_VERIFY_NETWORK_INSTALL=1 pnpm verify:pack
pnpm --registry=https://registry.npmjs.org audit --prod --audit-level high
```

本机也可运行 `pnpm verify:dsh-native`。它默认安装 `0.2.2-rc.5`，要求 Node 24.9 或更高版本。通过 `AGENT_DAG_DSH_VERSION` 切换验证目标，或者同时提供 `AGENT_DAG_DSH_BINARY` 指定相同版本的本机 DSH。验收使用独立的 `DSH_HOME` 和动态端口。

版本提交合并、CI 通过后推送同版本的 `v*` tag。`.github/workflows/release.yml` 校验 tag 与 `package.json` 版本一致，重新运行验收，再通过配置在 `GM-HZ/agent-dag-workflow` 仓库 `npm` Environment 的 npm Trusted Publisher 发布。已有同版本时，流水线仍执行验收并跳过重复上传。

```bash
npm view @gm-hz/agent-dag-workflow version dist-tags --registry=https://registry.npmjs.org
```
