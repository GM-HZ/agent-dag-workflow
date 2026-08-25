# AI model news Tool provider

Reference DSH Tool Provider used by the repository's weekly-news acceptance workflow. It registers `ai_model_news_search`, which aggregates Hacker News search and arXiv Atom data into a normalized, time-bounded list with `id`, `title`, `url`, `publishedAt`, `source`, and `kind`.

This package is intentionally a normal DSH Tool, not a Workflow Node. It demonstrates the lowest-cost provider boundary for external data and is private because it is an acceptance/reference adapter rather than part of the generic DAG runtime.
