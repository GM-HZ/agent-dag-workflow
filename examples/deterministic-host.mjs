import weeklyHost from './weekly-ai-model-news.mock-host.mjs'

const authority = {
  subject: 'example-regression',
  allowedTools: ['echo', 'web_search'],
  mode: 'deterministic-offline',
}

export default {
  authorityRef: 'example:deterministic-suite',
  authority,
  services: {
    tools: {
      async list() {
        return [
          { uses: 'echo', title: 'Echo', description: 'Deterministic echo Tool.' },
          { uses: 'web_search', title: 'Web search fixture', description: 'Deterministic offline search fixture.' },
        ]
      },
      async execute(request) {
        request.signal.throwIfAborted()
        if (!authority.allowedTools.includes(request.uses)) throw new Error(`deterministic Host denied Tool: ${request.uses}`)
        if (request.uses === 'echo') {
          if (typeof request.inputs.message !== 'string') throw new Error('echo.message must be a string')
          return { echo: request.inputs.message }
        }
        if (/^search-[0-9]{2}$/u.test(request.nodeId)) return weeklyHost.services.tools.execute(request)
        const category = request.nodeId.replace(/^search-/u, '')
        return {
          content: `Deterministic ${category} evidence`,
          sources: [0, 1].map(index => ({
            url: `https://evidence.example/${category}/${index + 1}`,
            title: `${category} evidence ${index + 1}`,
            snippet: `Source-grounded ${category} claim ${index + 1}`,
            publishedAt: `2026-08-${String(20 + index).padStart(2, '0')}T00:00:00+08:00`,
          })),
          truncated: false,
        }
      },
    },
    agents: {
      async execute(request) {
        request.signal.throwIfAborted()
        if (isWeeklyNode(request.nodeId)) return weeklyHost.services.agents.execute(request)
        const structured = deterministicAgentOutput(request)
        return {
          runId: `${request.runId}:${request.nodeId}:deterministic-agent`,
          content: [],
          structured,
        }
      },
    },
    approvals: {
      async request(request) {
        request.signal.throwIfAborted()
        if (request.action !== 'deploy-production') throw new Error(`unexpected approval action: ${request.action}`)
        return 'allowed-once'
      },
    },
  },
}

function isWeeklyNode(nodeId) {
  return ['plan-searches', 'normalize-news', 'score-news', 'summarize-top-10'].includes(nodeId)
}

function deterministicAgentOutput(request) {
  switch (request.nodeId) {
    case 'collect':
      return {
        items: [
          { claim: 'The runtime keeps Tool execution in the Host.', source: 'https://docs.example/runtime' },
          { claim: 'Journal and Checkpoint preserve auditable state.', source: 'https://docs.example/journal' },
        ],
      }
    case 'summarize':
      return { report: `Deterministic report for ${request.inputs.topic} with ${request.inputs.evidence.length} cited findings.` }
    case 'review': {
      const clause = request.inputs.clause
      const clauseId = typeof clause?.id === 'string' ? clause.id : `clause-${request.inputs.index}`
      const unlimited = typeof clause?.text === 'string' && clause.text.toLowerCase().includes('unlimited')
      return {
        clauseId,
        riskLevel: unlimited ? 'high' : 'low',
        issues: unlimited ? ['unlimited liability'] : [],
        recommendation: unlimited ? 'Cap liability at annual fees.' : 'Accept the clause.',
      }
    }
    case 'synthesize': {
      const results = request.inputs.results
      const blockingIssues = results.flatMap(result => result.outputs.riskLevel === 'high'
        ? [`${result.outputs.clauseId}: ${result.outputs.issues[0]}`]
        : [])
      return {
        reviewedClauses: results.length,
        executiveSummary: `Reviewed ${results.length} clauses; ${blockingIssues.length} blocking issue(s).`,
        blockingIssues,
      }
    }
    case 'plan-queries':
      return {
        marketQueries: ['Acme AI Runtime market adoption', 'Acme AI Runtime customers'],
        technologyQueries: ['Acme AI Runtime architecture', 'Acme AI Runtime benchmarks'],
        riskQueries: ['Acme AI Runtime incidents', 'Acme AI Runtime security'],
      }
    case 'extract-evidence':
      return { items: evidenceItems() }
    case 'synthesize-report':
      return {
        report: `Deterministic due-diligence report for ${request.inputs.subject}.`,
        citations: request.inputs.evidence.map(item => item.url),
      }
    case 'architecture-review':
      return { riskScore: 82, findings: ['Rollback evidence is required.'], recommendation: 'Escalate for approval.' }
    case 'security-review':
      return { riskScore: 74, findings: ['Verify Tool allowlists.'], recommendation: 'Approve with audit review.' }
    case 'senior-review':
      return { review: 'Confirm rollback and capability boundaries before release.' }
    case 'standard-review':
      return { review: 'Complete the standard release checklist.' }
    default:
      throw new Error(`deterministic Host has no Agent fixture for node: ${request.nodeId}`)
  }
}

function evidenceItems() {
  return ['market', 'technology', 'risk'].flatMap((category, categoryIndex) => [0, 1].map(index => ({
    id: `${category}-${index + 1}`,
    title: `${category} evidence ${index + 1}`,
    url: `https://evidence.example/${category}/${index + 1}`,
    category,
    confidence: 90 - categoryIndex * 5 - index,
    relevance: 95 - categoryIndex * 10 - index,
    claim: `Deterministic ${category} claim ${index + 1}`,
  })))
}
