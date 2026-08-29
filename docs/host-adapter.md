# Host Adapter 接入

Host Adapter 是 Runtime 与现有 Agent 生态之间的薄边界，不是 Provider 系统。Workflow 仍然只保存 DAG、固定 Tool/Skill 名、输入输出 Schema 和依赖 allowlist；凭据、连接、模型 SDK、MCP Client、DSH Tool 与真实权限都由 Host 持有。

## 最小接口

只实现当前 Workflow 实际使用的 Gateway。纯脚本 Workflow 可以不传 Host；只有 Tool 节点时只实现 `services.tools.execute`：

```js
import { defineWorkflowCliHost } from '@gm-hz/agent-dag-workflow/cli'

export default defineWorkflowCliHost({
  authorityRef: 'company:local-agent',
  authority: { subject: 'current-user', allowedTools: ['my_tool'] },
  services: {
    tools: {
      async execute(request) {
        request.signal.throwIfAborted()
        if (request.uses !== 'my_tool') throw new Error(`Tool denied: ${request.uses}`)
        const authority = request.authority
        if (authority === null || typeof authority !== 'object'
          || !Array.isArray(authority.allowedTools) || !authority.allowedTools.includes(request.uses)) {
          throw new Error('Authority denied')
        }
        return await callExistingTool(request.inputs)
      },
    },
  },
})
```

`defineWorkflowCliHost()` 不包装调用、不保存状态，只提供类型约束。CLI 加载模块时会 fail-fast 校验 Host 结构，避免执行到某个节点后才发现 `execute`、`request` 或 `resolve` 写错。

| Host 字段 | 何时实现 | 最小方法 |
| --- | --- | --- |
| `services.tools` | `tool.call@1` | `execute(request)`；`list(authority)` 可选 |
| `services.agents` | `agent.run@1` | `execute(request)` |
| `services.approvals` | `approval.request@1` | `request(request)` |
| `services.subworkflows` | 自定义子流程 Gateway | `execute(request)` |
| `services.capabilities` | 自定义 Node 能力 | `resolve(capability)` |
| `authorityResolver` | 后台恢复 | `resolve(authorityRef, signal)` |
| `registerNodes` | 定制 Node | `registerNodes(registry)` |

Gateway 的返回值仍会经过节点 Schema、`expects` 和 Workflow 输出 Schema；Host 不能跳过校验。节点只能取得 Node Definition 声明、且模板 `spec.requires` 允许的能力。Host 自己还必须执行真实 Authority 校验，`spec.requires` 不是授权来源。

## 运行最小示例

仓库内的 [`minimal-host.mjs`](../examples/minimal-host.mjs) 把已有 `echo` Tool 适配给通用 Tool Gateway。完整发布和运行过程为：

```bash
pnpm build
node lib/cli.js draft put examples/tool-echo.workflow.yaml --db .agent-dag-workflow.db --host examples/minimal-host.mjs
node lib/cli.js publish tool-echo --expected 1 --db .agent-dag-workflow.db --host examples/minimal-host.mjs
node lib/cli.js run tool-echo@1 --input-json '{"message":"hello"}' --db .agent-dag-workflow.db --host examples/minimal-host.mjs
```

成功结果保留 `runId`。读取权威轨迹时必须继续使用同一数据库和 Authority：

```bash
node lib/cli.js trace <runId> --events --db .agent-dag-workflow.db --host examples/minimal-host.mjs
```

## 错误与排查

CLI 的 `agent-workflow.cli/v1` 失败 Envelope 包含稳定 `error.code` 和机器可读 `error.hints`。Workflow 已经启动但节点失败时，结果仍是成功传输的 Envelope，`data.status` 为 `failed`、进程退出码为 5，并在 `data.hints` 给出 Trace 与 Host 排查命令。

重点区分：

- `WORKFLOW_HOST_LOAD_FAILED`：文件、ESM 或依赖加载失败；
- `WORKFLOW_HOST_INVALID`：Host 对象结构不符合最小 Gateway 契约；
- `WORKFLOW_AUTHORITY_DENIED`：Host/Authority 拒绝，不能通过扩大 `spec.requires` 绕过；
- `WORKFLOW_OUTPUT_INVALID`：动态结果不满足声明，应先读 Trace，再修 Host/Agent 输出；
- `WORKFLOW_RUN_FAILED`：读取 Trace 定位节点；缺少 Gateway 时传入正确的 `--host`。

Host Adapter 不读取模板里的明文 Secret，也不根据输入动态选择未声明的 Tool。连接信息应使用 `connectionRef`/`credentialRef` 等不透明引用，由 Host 在 Authority 范围内解析。
