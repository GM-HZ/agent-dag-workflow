# DSH / Canvas 快速开始

在 DeepSeek Harness 的 Web profile 装入同一个 npm 包，然后打开 Web UI。

```bash
dsh plugin --profile web add @gm-hz/agent-dag-workflow
dsh web
```

1. 打开一个顶层 Agent 会话，点击右下角的「工作流」。如果入口灰显，先选中一个会话。
2. 选择可运行示例，使用已填入的输入试运行。经典入门示例会原样返回输入消息，无需外部 Tool。
3. 查看结果并复制 Run ID。之后可以在运行历史中重新打开轨迹，核对节点状态和最终输出。

可在 Canvas 保存草稿、试运行，再单独确认发布。Agent 也可以通过 `workflow-builder` Skill 修改同一份 Workflow。宿主 Tool 在当前 DSH 会话里授权，权限和凭据沿用 DSH 配置。

想体验失败定位和离线回归，可以导入有基线与修复候选的订单例子。 [订单回归示例](../examples/order-normalization)
