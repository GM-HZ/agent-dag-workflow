const from = '2026-08-19T00:00:00+08:00'

const items = Array.from({ length: 100 }, (_, index) => {
  const publishedAt = `2026-08-${String(19 + (index % 7)).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00+08:00`
  const url = `https://source.example/ai-model-${index}`
  return {
    id: url,
    title: `AI model item ${index}`,
    url,
    publishedAt,
    source: 'source.example',
    kind: ['release', 'research', 'news', 'analysis'][index % 4],
    summary: `Source-grounded summary ${index}`,
  }
})

export default {
  authorityRef: 'example:weekly-mock',
  authority: { type: 'deterministic-example' },
  services: {
    tools: {
      async execute(request) {
        if (request.uses !== 'web_search') throw new Error(`unexpected Tool: ${request.uses}`)
        const batch = Number(request.nodeId.slice('search-'.length)) - 1
        const sources = items.slice(batch * 8, batch * 8 + 8)
        return {
          content: `Deterministic search result for ${request.nodeId}`,
          sources: sources.map(item => ({
            url: item.url,
            title: item.title,
            snippet: item.summary,
            publishedAt: item.publishedAt,
          })),
          truncated: true,
        }
      },
    },
    agents: {
      async execute(request) {
        let structured
        if (request.nodeId === 'plan-searches') {
          structured = { batches: Array.from({ length: 13 }, (_, batch) => ({
            queries: Array.from({ length: 4 }, (_, query) => `AI model topic ${batch}-${query} ${from}`),
          })) }
        } else if (request.nodeId === 'normalize-news') {
          structured = { items }
        } else if (request.nodeId === 'score-news') {
          structured = { scores: request.inputs.items.map((item, index) => ({
            id: item.id,
            importanceScore: (index * 37) % 101,
            importanceReason: `importance ${index}`,
          })) }
        } else if (request.nodeId === 'summarize-top-10') {
          structured = { summaries: request.inputs.items.map((item, index) => ({ id: item.id, digest: `摘要 ${index + 1}` })) }
        } else {
          throw new Error(`unexpected Agent node: ${request.nodeId}`)
        }
        return { runId: `${request.runId}:${request.nodeId}:mock-agent`, content: [], structured }
      },
    },
  },
}
