import type { Context } from '@deepseek-ai/cordis'

export interface Config {
  readonly hackerNewsEndpoint?: string
  readonly arxivEndpoint?: string
  readonly timeoutMs?: number
}

export interface AiModelNewsItem {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly publishedAt: string
  readonly source: 'Hacker News' | 'arXiv'
  readonly kind: 'news' | 'paper'
  readonly summary?: string
  readonly engagement?: { readonly points: number; readonly comments: number }
}

export interface AiModelNewsResult {
  readonly from: string
  readonly to: string
  readonly requestedLimit: number
  readonly candidateCount: number
  readonly availableCount: number
  readonly truncated: boolean
  readonly items: readonly AiModelNewsItem[]
  readonly sourceCounts: { readonly hackerNews: number; readonly arxiv: number }
}

interface ToolExecutionContext {
  readonly signal: AbortSignal
}

interface ToolRegistry {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly parameters: Readonly<Record<string, unknown>>
    readonly output: {
      readonly schema: Readonly<Record<string, unknown>>
      render(args: unknown, value: unknown): readonly { readonly type: 'text'; readonly text: string }[]
    }
    readonly isConcurrencySafe: (args: unknown) => boolean
    execute(args: unknown, context: ToolExecutionContext): Promise<unknown>
  }): () => void
}

type ProviderContext = Context & { readonly tools: ToolRegistry }

const DEFAULT_HN_ENDPOINT = 'https://hn.algolia.com/api/v1/search_by_date'
const DEFAULT_ARXIV_ENDPOINT = 'https://export.arxiv.org/api/query'
const DEFAULT_TOPICS = ['AI model', 'large language model', 'foundation model', 'multimodal model'] as const
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export const name = 'gm-hz-dsh-dag-workflow-ai-news-provider'
export const inject = ['tools']

export function apply(rawContext: Context, config: Config = {}): void {
  const ctx = rawContext as ProviderContext
  const options = normalizeConfig(config)
  ctx.effect(() => ctx.tools.register({
    name: 'ai_model_news_search',
    description: 'Return up to 100 normalized AI-model news and research items in an exact time window, with URL and publishedAt fields. Aggregates Hacker News and arXiv; supports no credentials.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to', 'limit'],
      properties: {
        from: { type: 'string', description: 'Inclusive ISO-8601 start time.' },
        to: { type: 'string', description: 'Inclusive ISO-8601 end time.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    output: {
      schema: aiModelNewsOutputSchema,
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      const input = newsInput(args)
      return searchAiModelNews(input, { ...options, signal: execution.signal })
    },
  }), 'dsh-dag-workflow: AI news Tool provider')
}

export async function searchAiModelNews(
  input: { readonly from: string; readonly to: string; readonly limit: number },
  options: Required<Config> & { readonly signal: AbortSignal; readonly fetch?: typeof fetch },
): Promise<AiModelNewsResult> {
  const from = parseInstant(input.from, 'from')
  const to = parseInstant(input.to, 'to')
  if (from.getTime() > to.getTime()) throw new Error('from must be before or equal to to')
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('limit must be an integer between 1 and 100')
  const request = options.fetch ?? fetch
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = AbortSignal.any([options.signal, timeout])
  const [hackerNewsGroups, arxivXml] = await Promise.all([
    Promise.all(DEFAULT_TOPICS.map(topic => fetchHackerNews(request, options.hackerNewsEndpoint, topic, from, to, signal))),
    fetchArxiv(request, options.arxivEndpoint, signal),
  ])
  const hackerNews = hackerNewsGroups.flatMap(normalizeHackerNews).filter(item => inWindow(item.publishedAt, from, to))
  const arxiv = normalizeArxiv(arxivXml).filter(item => inWindow(item.publishedAt, from, to))
  const deduplicated = deduplicate([...hackerNews, ...arxiv])
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) || left.id.localeCompare(right.id))
  const items = deduplicated.slice(0, input.limit)
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    requestedLimit: input.limit,
    candidateCount: items.length,
    availableCount: deduplicated.length,
    truncated: deduplicated.length > items.length,
    items,
    sourceCounts: { hackerNews: hackerNews.length, arxiv: arxiv.length },
  }
}

const aiModelNewsOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'requestedLimit', 'candidateCount', 'availableCount', 'truncated', 'items', 'sourceCounts'],
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    requestedLimit: { type: 'integer' },
    candidateCount: { type: 'integer' },
    availableCount: { type: 'integer' },
    truncated: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'url', 'publishedAt', 'source', 'kind'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, publishedAt: { type: 'string' },
          source: { type: 'string', enum: ['Hacker News', 'arXiv'] }, kind: { type: 'string', enum: ['news', 'paper'] },
          summary: { type: 'string' },
          engagement: {
            type: 'object', additionalProperties: false, required: ['points', 'comments'],
            properties: { points: { type: 'integer' }, comments: { type: 'integer' } },
          },
        },
      },
    },
    sourceCounts: {
      type: 'object', additionalProperties: false, required: ['hackerNews', 'arxiv'],
      properties: { hackerNews: { type: 'integer' }, arxiv: { type: 'integer' } },
    },
  },
} as const

function normalizeConfig(config: Config): Required<Config> {
  const timeoutMs = config.timeoutMs ?? 30000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error('ai-news-provider timeoutMs must be an integer between 1000 and 120000')
  }
  return {
    hackerNewsEndpoint: endpoint(config.hackerNewsEndpoint ?? DEFAULT_HN_ENDPOINT, 'hackerNewsEndpoint'),
    arxivEndpoint: endpoint(config.arxivEndpoint ?? DEFAULT_ARXIV_ENDPOINT, 'arxivEndpoint'),
    timeoutMs,
  }
}

function newsInput(value: unknown): { readonly from: string; readonly to: string; readonly limit: number } {
  if (!isRecord(value)) throw new Error('ai_model_news_search arguments must be an object')
  if (typeof value.from !== 'string' || typeof value.to !== 'string' || typeof value.limit !== 'number') {
    throw new Error('ai_model_news_search requires from, to, and limit')
  }
  return { from: value.from, to: value.to, limit: value.limit }
}

async function fetchHackerNews(
  request: typeof fetch,
  endpointValue: string,
  topic: string,
  from: Date,
  to: Date,
  signal: AbortSignal,
): Promise<unknown> {
  const url = new URL(endpointValue)
  url.searchParams.set('query', topic)
  url.searchParams.set('tags', 'story')
  url.searchParams.set('hitsPerPage', '100')
  url.searchParams.set('numericFilters', `created_at_i>=${Math.floor(from.getTime() / 1000)},created_at_i<=${Math.floor(to.getTime() / 1000)}`)
  return JSON.parse(await responseText(await request(url, { signal, headers: { accept: 'application/json' } })))
}

async function fetchArxiv(request: typeof fetch, endpointValue: string, signal: AbortSignal): Promise<string> {
  const url = new URL(endpointValue)
  url.searchParams.set('search_query', 'all:"large language model" OR all:"foundation model" OR all:"multimodal model"')
  url.searchParams.set('start', '0')
  url.searchParams.set('max_results', '250')
  url.searchParams.set('sortBy', 'submittedDate')
  url.searchParams.set('sortOrder', 'descending')
  return responseText(await request(url, { signal, headers: { accept: 'application/atom+xml' } }))
}

async function responseText(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`AI news source returned HTTP ${response.status}`)
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('AI news source response exceeds 8 MiB')
  return text
}

function normalizeHackerNews(value: unknown): AiModelNewsItem[] {
  if (!isRecord(value) || !Array.isArray(value.hits)) throw new Error('Hacker News returned an invalid payload')
  const items: AiModelNewsItem[] = []
  for (const hit of value.hits) {
    if (!isRecord(hit)) continue
    const title = textValue(hit.title) ?? textValue(hit.story_title)
    const url = textValue(hit.url) ?? textValue(hit.story_url)
    const publishedAt = textValue(hit.created_at)
    const objectId = textValue(hit.objectID)
    if (title === undefined || url === undefined || publishedAt === undefined || objectId === undefined) continue
    items.push({
      id: `hn:${objectId}`,
      title: compact(title),
      url: canonicalUrl(url),
      publishedAt: parseInstant(publishedAt, 'Hacker News created_at').toISOString(),
      source: 'Hacker News',
      kind: 'news',
      engagement: { points: integerOrZero(hit.points), comments: integerOrZero(hit.num_comments) },
    })
  }
  return items
}

function normalizeArxiv(xml: string): AiModelNewsItem[] {
  const items: AiModelNewsItem[] = []
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gu)) {
    const entry = match[1]!
    const id = xmlTag(entry, 'id')
    const title = xmlTag(entry, 'title')
    const published = xmlTag(entry, 'published') ?? xmlTag(entry, 'updated')
    if (id === undefined || title === undefined || published === undefined) continue
    const summary = xmlTag(entry, 'summary')
    items.push({
      id: `arxiv:${id.replace(/^https?:\/\/arxiv\.org\/abs\//u, '')}`,
      title: compact(title),
      url: canonicalUrl(id.replace(/^http:/u, 'https:')),
      publishedAt: parseInstant(published, 'arXiv published').toISOString(),
      source: 'arXiv',
      kind: 'paper',
      ...(summary === undefined ? {} : { summary: compact(summary).slice(0, 800) }),
    })
  }
  return items
}

function deduplicate(items: readonly AiModelNewsItem[]): AiModelNewsItem[] {
  const byUrl = new Map<string, AiModelNewsItem>()
  for (const item of items) {
    const current = byUrl.get(item.url)
    if (current === undefined || item.publishedAt > current.publishedAt) byUrl.set(item.url, item)
  }
  return [...byUrl.values()]
}

function xmlTag(entry: string, name: string): string | undefined {
  const value = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'u').exec(entry)?.[1]
  return value === undefined ? undefined : decodeXml(value)
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function canonicalUrl(value: string): string {
  const url = new URL(value)
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_')) url.searchParams.delete(key)
  }
  return url.toString()
}

function parseInstant(value: string, name: string): Date {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`${name} must be a valid ISO-8601 timestamp`)
  return new Date(time)
}

function inWindow(value: string, from: Date, to: Date): boolean {
  const time = Date.parse(value)
  return time >= from.getTime() && time <= to.getTime()
}

function endpoint(value: string, name: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error(`${name} must use https`)
  return url.toString()
}

function compact(value: string): string { return value.replace(/\s+/gu, ' ').trim() }
function textValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim().length > 0 ? value : undefined }
function integerOrZero(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0 }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
