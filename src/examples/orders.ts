import { readFile } from 'node:fs/promises'
import { parseWorkflowTemplate } from '../core/index.js'

export async function readBundledOrdersExample() {
  const examples = new URL('../../examples/', import.meta.url)
  const [templateSource, inputSource] = await Promise.all([
    readFile(new URL('script-transform.workflow.json', examples), 'utf8'),
    readFile(new URL('inputs/script-transform.json', examples), 'utf8'),
  ])
  return { template: parseWorkflowTemplate(templateSource), inputSource }
}
