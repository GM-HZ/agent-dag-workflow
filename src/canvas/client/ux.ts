import type {
  CanvasJsonObject,
  CanvasNodeDefinition,
  CanvasTrace,
  CanvasWorkflowDiagnostic,
  CanvasWorkflowDraft,
  CanvasWorkflowNode,
  CanvasWorkflowRequirement,
  CanvasWorkflowTemplate,
} from '../types.js'

export type WorkflowDocumentState = 'pristine' | 'unsaved' | 'dirty' | 'saved' | 'validated' | 'validated-dirty' | 'published'
export type WorkflowConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
export type WorkflowErrorKind = 'connection' | 'conflict' | 'permission' | 'validation' | 'not-found' | 'execution' | 'unknown'

export interface WorkflowErrorPresentation {
  readonly kind: WorkflowErrorKind
  readonly title: string
  readonly message: string
  readonly remedy: string
  readonly retryable: boolean
  readonly detail: string
}

export interface WorkflowTraceEventPresentation {
  readonly seq: number
  readonly title: string
  readonly detail: string
  readonly tone: 'neutral' | 'active' | 'success' | 'warning' | 'danger'
  readonly nodeId?: string
  readonly infrastructure: boolean
}

export interface WorkflowNodeRequirementPresentation {
  readonly kind: string
  readonly uses: string
  readonly declared: boolean
}

export interface WorkflowRecoverySnapshot {
  readonly version: 1
  readonly template: CanvasWorkflowTemplate
  readonly draft?: CanvasWorkflowDraft
  readonly inputsText: string
  readonly savedAt: number
}

const documentLabels: Record<WorkflowDocumentState, string> = {
  pristine: '新工作流',
  unsaved: '未保存',
  dirty: '有未保存更改',
  saved: '草稿已保存',
  validated: '校验通过',
  'validated-dirty': '校验通过 · 未保存',
  published: '已发布',
}

const connectionLabels: Record<WorkflowConnectionState, string> = {
  connecting: '正在连接 DSH',
  connected: '已连接',
  reconnecting: '正在重新连接',
  disconnected: 'DSH 连接已中断',
}

export function documentStateLabel(state: WorkflowDocumentState): string { return documentLabels[state] }
export function connectionStateLabel(state: WorkflowConnectionState): string { return connectionLabels[state] }
export function hasUnsavedChanges(state: WorkflowDocumentState): boolean {
  return state === 'unsaved' || state === 'dirty' || state === 'validated-dirty'
}

export function classifyWorkflowError(cause: unknown): WorkflowErrorPresentation {
  const detail = errorDetail(cause)
  const normalized = detail.toLocaleLowerCase()
  if (/(failed to fetch|networkerror|econnreset|econnrefused|socket|disconnected|load failed)/i.test(detail)) {
    return {
      kind: 'connection', title: '暂时无法连接 DSH',
      message: 'DSH 可能正在重启或连接刚刚中断。当前画布内容已保留。',
      remedy: '等待服务恢复后重试；连接恢复时工作流会自动重新同步。', retryable: true, detail,
    }
  }
  if (/(revision|catalog).*(conflict|mismatch)|expectedrevision|cas/i.test(normalized)) {
    return {
      kind: 'conflict', title: '草稿已在其他位置更新',
      message: '当前画布基于较早的草稿修订，直接保存可能覆盖其他更改。',
      remedy: '先复制当前 JSON 作为备份，再重新加载最新草稿并比较差异。', retryable: false, detail,
    }
  }
  if (/(access denied|permission|unauthori[sz]ed|forbidden|not allowed)/i.test(detail)) {
    return {
      kind: 'permission', title: '当前会话没有执行权限',
      message: '该操作不在当前顶层 Agent 会话的授权范围内。',
      remedy: '回到有权限的顶层会话，或检查工作流声明的依赖与 DSH 策略。', retryable: false, detail,
    }
  }
  if (/(gateway_missing|requires a workflow(?:tool|agent|approval)gateway|host gateway)/i.test(detail)) {
    return {
      kind: 'validation', title: 'Host 未提供节点能力',
      message: '模板声明了外部节点，但当前 Host/Agent 没有暴露对应 Gateway。',
      remedy: '为当前入口接入所需 Tool/Agent Gateway；不要在脚本中绕过外部能力边界。', retryable: false, detail,
    }
  }
  if (/(not found|does not exist|unknown node type|unknown tool)/i.test(detail)) {
    return {
      kind: 'not-found', title: '引用的资源不存在',
      message: '工作流引用的草稿、运行、节点或 Tool 在当前环境中不可用。',
      remedy: '刷新节点目录，并检查模板中的精确名称和版本。', retryable: false, detail,
    }
  }
  if (/(invalid|schema|diagnostic|undeclared dependency|expectation failed|input.*required|must have required property|must match)/i.test(detail)) {
    return {
      kind: 'validation', title: '数据或模板未通过校验',
      message: '输入、节点输出或工作流结构不符合已经声明的契约。',
      remedy: '打开“问题”并修正对应节点；不要放宽依赖或输出 Schema 来绕过错误。', retryable: false, detail,
    }
  }
  if (/(tool[_ ]failed|agent[_ ]failed|node .* failed|workflow .* failed|cancelled|timed? ?out)/i.test(detail)) {
    return {
      kind: 'execution', title: '工作流执行失败',
      message: '运行已经停止，失败节点和原始原因已保留在审计轨迹中。',
      remedy: '选择失败节点查看输入、输出契约和错误详情，再决定修改或重试。', retryable: false, detail,
    }
  }
  return {
    kind: 'unknown', title: '操作未完成', message: 'DSH 返回了暂时无法归类的错误。',
    remedy: '保留当前画布后重试；如仍失败，请导出日志并附上下面的技术详情。', retryable: false, detail,
  }
}

export function diagnosticTitle(diagnostic: CanvasWorkflowDiagnostic): string {
  const known: Record<string, string> = {
    WORKFLOW_REQUIREMENT_UNDECLARED: '依赖尚未声明',
    DUPLICATE_WORKFLOW_REQUIREMENT: '依赖重复声明',
    UNKNOWN_NODE_TYPE: '节点类型不可用',
    UNKNOWN_OUTPUT_PORT: '输出端口不存在',
    UNKNOWN_WORKFLOW_INPUT: '工作流输入不存在',
    UNKNOWN_BINDING_NODE: '绑定引用了不存在的节点',
    WORKFLOW_SCHEMA_INVALID: '工作流 Schema 无效',
    WORKFLOW_OUTPUT_BINDING_INVALID: '工作流输出绑定无效',
    WORKFLOW_OUTPUT_SOURCE_NOT_END: '工作流输出必须来自结束节点',
    SUBWORKFLOW_REVISION_NOT_FOUND: '子工作流修订不存在',
    SUBWORKFLOW_DEPENDENCY_CYCLE: '子工作流形成循环依赖',
  }
  return known[diagnostic.code] ?? (diagnostic.severity === 'error' ? '需要修复的问题' : '建议检查')
}

export function traceEventPresentation(event: CanvasJsonObject): WorkflowTraceEventPresentation {
  const seq = typeof event.seq === 'number' ? event.seq : 0
  const type = typeof event.type === 'string' ? event.type : 'unknown'
  const nodeId = typeof event.nodeId === 'string' ? event.nodeId : undefined
  const edgeId = typeof event.edgeId === 'string' ? event.edgeId : undefined
  const error = typeof event.error === 'string' ? event.error : typeof event.reason === 'string' ? event.reason : undefined
  const labels: Record<string, readonly [string, WorkflowTraceEventPresentation['tone']]> = {
    'run.started': ['开始运行', 'active'], 'run.resumed': ['继续运行', 'active'],
    'run.completed': ['运行完成', 'success'], 'run.failed': ['运行失败', 'danger'],
    'run.cancelled': ['运行已取消', 'warning'], 'run.paused': ['运行已暂停', 'warning'],
    'node.ready': ['节点已就绪', 'neutral'], 'node.started': ['节点开始执行', 'active'],
    'node.waiting': ['等待人工处理', 'warning'], 'node.progress': ['节点进度已保存', 'active'],
    'node.completed': ['节点执行完成', 'success'], 'node.skipped': ['节点已跳过', 'neutral'],
    'node.cancelled': ['节点已取消', 'warning'], 'node.needs-attention': ['节点需要处理', 'warning'],
    'node.failed': ['节点执行失败', 'danger'], 'edge.taken': ['采用连接', 'active'],
    'edge.skipped': ['跳过连接', 'neutral'], 'checkpoint.committed': ['检查点已持久化', 'neutral'],
    'capability.requested': ['请求外部能力', 'active'], 'capability.completed': ['外部能力已返回', 'success'],
    'capability.replayed': ['复用已记录结果', 'neutral'], 'capability.failed': ['外部能力调用失败', 'danger'],
  }
  const [title, tone] = labels[type] ?? [type, 'neutral']
  return {
    seq, title, tone,
    detail: error ?? nodeId ?? edgeId ?? (typeof event.runId === 'string' ? event.runId : '工作流'),
    ...(nodeId === undefined ? {} : { nodeId }),
    infrastructure: type === 'checkpoint.committed' || type.startsWith('edge.'),
  }
}

export function nodeRequirementPresentation(
  node: CanvasWorkflowNode,
  definition: CanvasNodeDefinition | undefined,
  declared: readonly CanvasWorkflowRequirement[],
): readonly WorkflowNodeRequirementPresentation[] {
  const requested: CanvasWorkflowRequirement[] = [...(definition?.defaultRequirements ?? [])]
  for (const capability of definition?.capabilities ?? []) requested.push({ kind: 'capability', uses: capability })
  const fixedTool = node.uses === 'tool.call@1' && typeof node.with.uses === 'string' ? node.with.uses : undefined
  if (fixedTool !== undefined) requested.push({ kind: 'tool', uses: fixedTool })
  if (node.uses === 'agent.run@1') {
    for (const uses of stringArray(node.with.tools)) requested.push({ kind: 'tool', uses })
    for (const uses of stringArray(node.with.skills)) requested.push({ kind: 'skill', uses })
  }
  const allowlist = new Set(declared.map(item => `${item.kind}:${item.uses}`))
  const unique = new Map<string, CanvasWorkflowRequirement>()
  for (const requirement of requested) unique.set(`${requirement.kind}:${requirement.uses}`, requirement)
  return [...unique.values()].map(requirement => ({
    ...requirement,
    declared: allowlist.has(`${requirement.kind}:${requirement.uses}`),
  }))
}

export function visibleTraceEvents(trace: CanvasTrace, includeInfrastructure = false): readonly WorkflowTraceEventPresentation[] {
  return trace.events.map(traceEventPresentation).filter(event => includeInfrastructure || !event.infrastructure)
}

export function workflowFailurePresentation(trace: CanvasTrace | undefined): WorkflowErrorPresentation | undefined {
  if (trace?.error === undefined) return undefined
  return classifyWorkflowError(trace.error)
}

export function recoveryStorageKey(sessionId: string): string {
  return `agent-dag-workflow:recovery:${sessionId}`
}

export function serializeRecoverySnapshot(snapshot: WorkflowRecoverySnapshot): string {
  return JSON.stringify(snapshot)
}

export function parseRecoverySnapshot(source: string | null): WorkflowRecoverySnapshot | undefined {
  if (source === null) return undefined
  try {
    const value = JSON.parse(source) as unknown
    if (!isRecord(value) || value.version !== 1 || typeof value.inputsText !== 'string'
      || typeof value.savedAt !== 'number' || !isTemplate(value.template)) return undefined
    const draft = isDraft(value.draft) ? value.draft : undefined
    return { version: 1, template: value.template, inputsText: value.inputsText, savedAt: value.savedAt, ...(draft === undefined ? {} : { draft }) }
  } catch { return undefined }
}

function isDraft(value: unknown): value is CanvasWorkflowDraft {
  return isRecord(value) && typeof value.id === 'string' && typeof value.revision === 'number'
    && typeof value.contentHash === 'string' && typeof value.semanticHash === 'string'
    && typeof value.createdAt === 'number' && typeof value.updatedAt === 'number' && isTemplate(value.template)
}

function stringArray(value: CanvasJsonObject[string] | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function starterTemplate(seed = Date.now()): CanvasWorkflowTemplate {
  return {
    apiVersion: 'workflow.gm-hz.dev/v1alpha1', kind: 'WorkflowTemplate',
    metadata: { id: `hello-workflow-${seed}`, name: '第一个工作流', description: '接收一段文本，并通过可审计 DAG 原样输出。' },
    spec: {
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['message'],
        properties: { message: { type: 'string', description: '要传入工作流的文本' } },
      },
      outputSchema: {
        type: 'object', additionalProperties: false, required: ['message'],
        properties: { message: { type: 'string' } },
      },
      nodes: [
        { id: 'start', uses: 'core.start@1', title: '开始', with: {}, inputs: {} },
        { id: 'end', uses: 'core.end@1', title: '输出结果', with: {}, inputs: { message: { input: { path: ['message'] } } } },
      ],
      edges: [{ id: 'start-end', source: 'start', target: 'end' }],
      outputs: { message: { output: { nodeId: 'end', path: ['message'] } } },
    },
    layout: { canvas: { positions: { start: { x: 180, y: 220 }, end: { x: 540, y: 220 } } } },
  }
}

export function definitionGroup(definition: CanvasNodeDefinition): 'nodes' | 'tools' {
  return definition.kind === 'tool' ? 'tools' : 'nodes'
}

const builtInNodeCopy: Record<string, readonly [string, string]> = {
  'core.start@1': ['开始', '校验并向 DAG 暴露工作流输入。'],
  'core.end@1': ['结束', '汇总一个终态工作流输出对象。'],
  'core.condition@1': ['条件分支', '使用固定且无 eval 的运算符选择 true 或 false 路径。'],
  'core.foreach@1': ['批量处理', '对每项运行固定发布修订，并持久化每个处理进度。'],
  'core.script@1': ['确定性 JSON 变换', '通过受限脚本运行时变换 JSON；外部调用仍走 DSH Tool。'],
  'workflow.call@1': ['子工作流', '以可恢复子调用运行一个固定的已发布修订。'],
  'agent.run@1': ['Agent 执行', '在当前 DSH Agent 权限范围内运行一个前台子 Agent。'],
  'human.approval@1': ['人工审批', '通过 DSH 审批边界请求一次默认拒绝的明确决定。'],
}

export function definitionDisplayTitle(definition: CanvasNodeDefinition): string {
  return definition.kind === 'tool' ? definition.title : builtInNodeCopy[definition.uses]?.[0] ?? definition.title
}

export function definitionDisplayDescription(definition: CanvasNodeDefinition): string {
  return definition.kind === 'tool' ? definition.description : builtInNodeCopy[definition.uses]?.[1] ?? definition.description
}

function errorDetail(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  try { return JSON.stringify(cause) } catch { return String(cause) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTemplate(value: unknown): value is CanvasWorkflowTemplate {
  return isRecord(value) && value.apiVersion === 'workflow.gm-hz.dev/v1alpha1' && value.kind === 'WorkflowTemplate'
    && isRecord(value.metadata) && typeof value.metadata.id === 'string' && typeof value.metadata.name === 'string'
    && isRecord(value.spec) && Array.isArray(value.spec.nodes) && Array.isArray(value.spec.edges)
}
