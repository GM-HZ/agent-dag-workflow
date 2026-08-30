# 5 分钟快速开始

目标是先运行一个确定性 Workflow，看到结果和权威 Trace，再决定是否接入外部 Tool。

## 1. 安装

要求 Node.js 22.19+：

```bash
npm install @gm-hz/agent-dag-workflow
```

包同时提供正式命令 `agent-workflow` 和简写 `adw`，两者执行完全相同的 CLI。

## 2. 校验并发布示例

```bash
adw validate examples/script-transform.workflow.json
adw draft put examples/script-transform.workflow.json
adw publish script-transform-demo --expected 1
```

默认数据保存在当前目录 `.agent-dag-workflow.db`。生产调用固定发布修订，不使用“latest”。

## 3. 运行

```bash
adw run script-transform-demo@1 \
  --input examples/inputs/script-transform.json
```

成功 Envelope 包含 `runId`、`status: completed` 和结构化输出。

## 4. 读取 Trace

```bash
adw trace <runId> --events
```

Trace 来自权威 Journal，不是 UI 临时日志。每个外部调用、输出提交和终态都按 `seq` 排序。

## 下一步

- 想让 Codex 自动发现和运行：进入 [Codex / Skill](./codex)。
- 想创建自己的 JSON：进入 [创作与发布](./authoring)。
- 想接入 Tool 或 Agent：阅读 [Host Adapter](../host-adapter)。
- 想直接检查复杂能力：运行 [9 个可执行 Examples](../examples/)。
