import { describe, expect, it, vi } from 'vitest'
import { searchAiModelNews } from '../src/index.js'

const signal = new AbortController().signal

describe('AI model news Tool provider', () => {
  it('normalizes, filters, deduplicates, orders, and caps real provider shapes', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input)
      if (url.includes('hn.example')) {
        const query = new URL(url).searchParams.get('query')
        return new Response(JSON.stringify({ hits: [
          { objectID: `${query}-1`, title: `News ${query}`, url: `https://example.com/${query}?utm_source=test`, created_at: '2026-08-23T10:00:00Z', points: 10, num_comments: 3 },
          { objectID: `${query}-old`, title: 'Old', url: 'https://example.com/old', created_at: '2026-08-01T10:00:00Z' },
        ] }), { status: 200 })
      }
      return new Response(`<?xml version="1.0"?><feed>
        <entry><id>http://arxiv.org/abs/2608.00001v1</id><title>  Model Paper One </title><published>2026-08-24T12:00:00Z</published><summary> First &amp; best. </summary></entry>
        <entry><id>http://arxiv.org/abs/2608.00002v1</id><title>Old Paper</title><published>2026-08-01T12:00:00Z</published></entry>
      </feed>`, { status: 200 })
    })
    const result = await searchAiModelNews({
      from: '2026-08-18T00:00:00Z',
      to: '2026-08-25T00:00:00Z',
      limit: 3,
    }, {
      hackerNewsEndpoint: 'https://hn.example/search',
      arxivEndpoint: 'https://arxiv.example/query',
      timeoutMs: 5000,
      signal,
      fetch: fetcher,
    })

    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(result).toMatchObject({ candidateCount: 3, availableCount: 5, truncated: true })
    expect(result.items[0]).toMatchObject({ source: 'arXiv', title: 'Model Paper One', summary: 'First & best.' })
    expect(result.items.slice(1).every(item => !item.url.includes('utm_source'))).toBe(true)
    expect(result.items.every(item => Date.parse(item.publishedAt) >= Date.parse('2026-08-18T00:00:00Z'))).toBe(true)
  })

  it('rejects invalid windows, limits, and source responses', async () => {
    const options = {
      hackerNewsEndpoint: 'https://hn.example/search',
      arxivEndpoint: 'https://arxiv.example/query',
      timeoutMs: 5000,
      signal,
      fetch: vi.fn<typeof fetch>(async () => new Response('no', { status: 500 })),
    }
    await expect(searchAiModelNews({ from: 'bad', to: '2026-08-25T00:00:00Z', limit: 100 }, options)).rejects.toThrow(/valid ISO/)
    await expect(searchAiModelNews({ from: '2026-08-25T00:00:00Z', to: '2026-08-18T00:00:00Z', limit: 100 }, options)).rejects.toThrow(/before/)
    await expect(searchAiModelNews({ from: '2026-08-18T00:00:00Z', to: '2026-08-25T00:00:00Z', limit: 101 }, options)).rejects.toThrow(/between 1 and 100/)
    await expect(searchAiModelNews({ from: '2026-08-18T00:00:00Z', to: '2026-08-25T00:00:00Z', limit: 100 }, options)).rejects.toThrow(/HTTP 500/)
  })
})
