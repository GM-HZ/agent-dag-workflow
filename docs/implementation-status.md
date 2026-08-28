# 实现状态与完成审计

本表是“完整实现总体设计”的验收清单。`完成` 必须同时有实现、测试和公开入口；仅有设计文档或类型定义记为 `未开始/部分完成`。

| 能力 | 状态 | 当前证据 | 未完成项 |
|---|---|---|---|
| Template v1alpha1 envelope/binding/layout | 完成 | `types.ts`、`schema.ts`、lossless JSON、必填 binding/workflow input/output path/可判定 schema type diagnostics | v1alpha1 无前代版本；未来版本必须新增显式 migration |
| 节点注册与插件卸载 | 完成 | `registry.ts`、compiler lease 测试、Cordis registry service 测试 | 后续只需扩充节点类型 |
| 编译诊断、DAG、上游 binding、端口、终态路径 | 完成 | `compiler.ts`、compiler/catalog tests，含固定 revision 存在性、依赖环、继承深度校验 | 无 |
| 内存调度、condition/join/skip、取消、caps | 完成 | `engine.ts`、`engine.spec.ts` | 持久事务与恢复由下一项承接 |
| `start/end/tool/condition/script` | 完成 | `nodes.ts`、`expression.ts` 与核心/DSH 集成测试 | 无 |
| 确定性脚本 runtime SDK | 完成 | `WorkflowScriptRuntimeRegistry`、内置 `json.expr@1`、稳定 `sortBy`、确定性 `withIndex`、防覆盖 `joinBy`、语义诊断、操作预算/取消/安全 key 测试 | 后续按真实需求扩充 builtin，不引入通用 eval |
| 两级扩展 / Capability manifest / `spec.requires` | 完成 | scope-visible Tool 自动物化为通用 `tool.call@1`；自定义 Node registry + scoped `WorkflowCapabilityRegistry`；resource resolver、secret inference、duplicate/undeclared diagnostics | 领域约束留在具体 DSH Tool/自定义 Node，不在 Core 枚举 |
| 动态结果契约 / `node.expects` | 完成 | 实例 JSON Schema、节点级 byte cap、checkpoint 前校验、下游 binding schema 收窄测试 | Agent 语义 review 复用显式 `agent.run@1`，不进入安全边界 |
| DSH Cordis `ctx.workflowCapabilities/workflowScripts/workflowNodes/dagWorkflowEngine` | 完成 | `packages/dsh/src/services.ts`、Tool 与自定义 Node 两级端到端测试 | 加入正式 DSH bundle patch |
| 真实 `ctx.tools.execute()` policy path | 完成 | Cordis stub 端到端证明 owning Agent/signal/args 透传 | 在完整 Harness composition 中再跑兼容门禁 |
| Run trace 与实时事件 | 完成 | SQLite run/node event、observer containment；Canvas `workflowCanvasUi.open({runId, templateId, nodeId})` 跳转 seam | DSH 开放仓外 Session event 注册前不写自定义 Session event |
| Template catalog、draft/revision/hash/CAS/publish | 完成 | `packages/catalog` 领域测试、SQLite 重开/CAS/ownership 测试、Cordis service | 无 |
| Run event store、checkpoint、crash recovery | 完成 | 内存/SQLite store、原子 seq CAS、故障注入、重开恢复、container frame、approval waiting、authorityRef 与 Host 自动恢复协调器 | 无 |
| `agent/foreach/subworkflow/human-approval` | 完成 | DSH seam 集成、固定 revision gate、确定性 child invocation、item frame 故障恢复、父子 attention 传播测试 | 无 |
| Agent CRUD/validate/diff/publish/run tools | 完成 | 10 个 `workflow_*` tools；大型 JSON import、draft validate、scope-visible node/tool/script runtime/current-Agent schemas、CAS、显式 revision run 集成测试 | 无 |
| 真实 100→10 外部数据验收 | 完成 | 内置 `web_search` 13 路 fan-out + weekly-news 模板；最多 100 个候选、评分 overlay、稳定 Top10、摘要 overlay、防篡改 join、20 节点持久 trace 集成测试 | 无额外插件依赖 |
| `workflow-builder` Skill | 完成 | bundled `SKILL.md` + `agents/openai.yaml`，官方 `quick_validate.py` 与 npm pack 检查 | 无 |
| Canvas Host RPC 与 Client overlay | 完成 | `packages/canvas`：12 Remote descriptors、shell overlay、XYFlow、schema form、diagnostics、CAS/diff/publish/run/trace/resume、renderer registry、navigation controller | 无 |
| 安全/权限/secret/idempotency review | 完成 | Canvas 实时顶层 Agent lookup、多用户附加 authority、tool/agent/approval policy path、secret transient/leak gate、unknown side-effect attention | 结论与部署责任见 `docs/security.md` |
| CI、构建、包内容、MIT | 完成 | `.github/workflows/ci.yml`、pack 检查、LICENSE | 发布前 provenance/SBOM 可选 |

## Cordis 兼容性审阅结论

1. Service 方法会经 Proxy 调用，禁止原生 `#private`；测试已覆盖此项。
2. 所有注册必须由 `ctx.effect()` 持有；核心节点在插件卸载后移除。
3. Host 插件卸载必须 cancel + await active runs，不能只删除 service key。
4. DSH 仍处于预览版本且包发布不同步；Tools/Agent 使用结构桥接，Cordis 使用精确兼容 peer range。
5. 完整 trace 写入独立 Workflow Run Store；实时 listener 失败不能改变执行面。DSH 当前不允许安全注册仓外 Session event，因此不向 Session 日志写自定义类型。

## 恢复语义审阅结论

1. checkpoint 与同批事件在一个 store commit 中提交，`seq` 必须连续；observer 只能在持久化成功后看到事件。
2. 恢复使用已保存模板的 `semanticHash` 做一致性门禁，不接受调用方替换模板。
3. 崩溃时处于 `running` 的安全节点可自动重试；`retry: never` 的副作用节点进入 `needs_attention`，必须由操作者显式选择 `retry/fail`。
4. `maxDurationMs` 从原始 `createdAt` 计算，进程重启不会刷新预算；terminal run 的 resume 是幂等读取。
5. SQLite v2 把 run checkpoint 与事件日志放在同一事务中，并保留 catalog-only v1 数据库的迁移路径。
6. 人工节点调用 approval seam 前先提交 `waiting` checkpoint；稳定 workflow call id 关联同一节点，崩溃恢复可安全地重新进入询问流程。
7. subworkflow/foreach 的 child run id 由稳定 invocation id 派生；父进程丢失完成回执时只读取同一个 terminal child，不重放其副作用。
8. foreach 的每个 item frame 保存 `pending/running/completed + child run id + outputs`；祖先 subworkflow depth ceiling 随 child checkpoint 持久化，后代不能重新放宽。
9. 自动恢复只处理 `running + authorityRef`；Host resolver 不能返回有效 Agent 时保留原 checkpoint，`paused` 必须由操作者恢复。

## Canvas 兼容性审阅结论

1. Host 使用官方 Typert protocol 与生成器，生成 12 个带 Zod wire codec 的 Remote descriptor；Client 自行 `$mount` contribution。
2. `shell.overlay` 是 additive list slot，不替换 DSH `root`/conversation/details owner。
3. 浏览器不传 Agent object；每个 RPC 都先从 Host 实时 registry 解析顶层 Agent，再执行可选的 `authorize(sessionId, agent, action, resourceId)`；多人部署必须提供该策略。
4. Canvas 只在 `layout.canvas.positions` 写坐标；node/edge/config/binding 始终是同一份 `WorkflowTemplate`。
5. 真实 Chromium 已验证 1200×744 和 900×700、节点选择、palette 新增与最终 0 console error/warning。
6. 节点 palette 使用 definition `defaultConfig`，并把 scope-visible DSH Tool 直接映射为 `tool.call@1`；脚本 source 使用 multiline editor，保存的仍是同一份 `WorkflowTemplate`。
