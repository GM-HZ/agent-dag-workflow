import { defineWorkflowCliHost } from '@gm-hz/agent-dag-workflow/cli'

const allowedTools = new Set(['echo'])

export default defineWorkflowCliHost({
  authorityRef: 'example:minimal-host',
  authority: { subject: 'local-example', allowedTools: [...allowedTools] },
  services: {
    tools: {
      async list(authority) {
        if (!isToolAllowed(authority, 'echo')) return []
        return [{
          uses: 'echo',
          title: 'Echo',
          description: 'Return the supplied message without external I/O.',
          inputSchema: {
            type: 'object', additionalProperties: false, required: ['message'],
            properties: { message: { type: 'string' } },
          },
          outputSchema: {
            type: 'object', additionalProperties: false, required: ['echo'],
            properties: { echo: { type: 'string' } },
          },
          idempotency: 'idempotent',
        }]
      },
      async execute(request) {
        request.signal.throwIfAborted()
        if (!isToolAllowed(request.authority, request.uses)) throw new Error(`Tool is not allowed by this Authority: ${request.uses}`)
        if (typeof request.inputs.message !== 'string') throw new Error('echo.message must be a string')
        return { echo: request.inputs.message }
      },
    },
  },
})

function isToolAllowed(authority, uses) {
  return allowedTools.has(uses)
    && authority !== null
    && typeof authority === 'object'
    && Array.isArray(authority.allowedTools)
    && authority.allowedTools.includes(uses)
}
