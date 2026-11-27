import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const port = await availablePort()
const url = `http://127.0.0.1:${port}/`
const session = `agent-dag-canvas-${process.pid}`
const server = spawn(pnpm, ['exec', 'vite', 'tests/canvas/visual', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOutput = ''
server.stdout.on('data', chunk => { serverOutput += chunk.toString() })
server.stderr.on('data', chunk => { serverOutput += chunk.toString() })

try {
  await waitForServer(url, server)
  runCli('open', url)
  runCli('run-code', String.raw`async page => {
    const consoleErrors = []
    const confirmations = []
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('pageerror', error => consoleErrors.push(error.message))
    page.on('dialog', dialog => { confirmations.push(dialog.message()); void dialog.accept() })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.reload()
    const studio = page.locator('[data-workflow-studio]')
    await studio.waitFor()
    if (await studio.count() !== 1) throw new Error('Canvas Studio did not mount exactly once')

    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-workflow-studio]')).colorScheme === 'dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-workflow-studio]')).colorScheme === 'light')

    const name = page.getByRole('textbox', { name: 'Workflow name' })
    await name.fill('Browser smoke draft')
    await page.evaluate(() => { document.documentElement.lang = 'zh-CN' })
    const chineseName = page.getByRole('textbox', { name: '工作流名称' })
    await chineseName.waitFor()
    if (await chineseName.inputValue() !== 'Browser smoke draft') throw new Error('Language change lost the current draft')
    await page.getByRole('button', { name: '保存', exact: true }).waitFor()
    await page.getByRole('button', { name: '适应视图', exact: true }).waitFor()
    await page.evaluate(() => { document.documentElement.lang = 'en-US' })
    await page.getByRole('button', { name: 'Fit view', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('[data-state="saved"]').waitFor()
    await name.fill('Browser smoke updated')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('[data-state="saved"]').waitFor()

    await page.getByRole('button', { name: 'Validate', exact: true }).click()
    await page.locator('[data-state="validated"]').waitFor()
    await page.getByText('No structure, dependency, or schema issues found.', { exact: true }).waitFor()

    await page.getByText('Run may call real Host tools or agents.', { exact: true }).waitFor()
    await page.getByRole('button', { name: '▶ Run draft', exact: true }).click()
    await page.locator('.wf-run-state.wf-completed').waitFor()
    await page.getByText('Run complete', { exact: true }).first().waitFor()
    const result = page.getByRole('region', { name: 'Run result' })
    await result.getByText('visual-run-1', { exact: true }).waitFor()
    await result.getByText(/"quality": "verified"/).waitFor()
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await result.getByRole('button', { name: 'Copy run ID' }).click()
    await page.getByRole('status').getByText('Run ID copied').waitFor()
    if (await page.evaluate(() => navigator.clipboard.readText()) !== 'visual-run-1') throw new Error('Run ID copy mismatch')
    await page.evaluate(() => { document.documentElement.lang = 'zh-CN' })
    await page.getByText('运行完成', { exact: true }).first().waitFor()
    await page.evaluate(() => { document.documentElement.lang = 'en' })
    await page.getByText('Run complete', { exact: true }).first().waitFor()
    if (await page.locator('.wf-graph-node[data-status="succeeded"]').count() < 4) {
      throw new Error('Trace did not project completed node state back onto the graph')
    }

    const input = page.getByRole('textbox', { name: 'Run input JSON' })
    const testRun = page.getByRole('button', { name: '▶ Run draft', exact: true })
    await input.fill('[]')
    await testRun.click()
    await page.getByRole('button', { name: /Run input must be a valid JSON object.*Edit run input/ }).click()
    if (!(await input.evaluate(element => element === document.activeElement))) throw new Error('Run input diagnostic should focus the editor')
    await input.fill('{"blockTool":true}')
    await testRun.click()
    await page.getByRole('button', { name: /Tool unavailable in this session.*Inspect node research/ }).click()
    await page.getByRole('heading', { name: 'research', exact: true }).waitFor()
    if ((await page.evaluate(() => window.__canvasSmoke)).calls.runDraft !== 1) throw new Error('Blocked inputs reached the run endpoint')

    await input.fill('{"fail":true}')
    await testRun.click()
    await page.getByRole('button', { name: /Inspect failed node research/ }).click()
    await page.getByText('DSH_TOOL_FAILED: visual fixture failure', { exact: true }).first().waitFor()

    await input.fill('{"custom":"keep on reopen"}')
    await page.getByRole('button', { name: 'New', exact: true }).click()
    if (await input.inputValue() !== '{}') throw new Error('New workflow inherited another draft’s inputs')
    await page.getByRole('combobox', { name: 'Select workflow draft' }).selectOption('research-signal')
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Run input JSON"]').value === '{"custom":"keep on reopen"}')
    await page.getByRole('button', { name: 'New', exact: true }).click()
    await page.getByRole('button', { name: /Start with a runnable example/ }).click()
    const starterMessage = JSON.parse(await input.inputValue()).message
    if (starterMessage !== 'Hello, DSH Workflow') throw new Error('Starter did not populate matching run input')
    await page.getByText('Run uses only local workflow nodes.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Input form', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Run inputs' })
    await form.getByRole('textbox', { name: /message/ }).fill('Personal starter run')
    await form.getByRole('textbox', { name: /message/ }).press('Enter')
    if (JSON.parse(await input.inputValue()).message !== 'Personal starter run') throw new Error('Input form did not update the run JSON')
    await testRun.click()
    await result.getByText(/"message": "Personal starter run"/).waitFor()

    const smoke = await page.evaluate(() => window.__canvasSmoke)
    const expectedCalls = { createDraft: 1, updateDraft: 1, validate: 5, runDraft: 3, trace: 3 }
    for (const [operation, expected] of Object.entries(expectedCalls)) {
      if (smoke?.calls?.[operation] !== expected) throw new Error(operation + ' call count was ' + smoke?.calls?.[operation])
    }
    if (smoke.savedName !== 'Browser smoke updated') throw new Error('updated draft did not reach the Canvas API')

    await page.getByRole('button', { name: 'Run history', exact: true }).click()
    const history = page.getByRole('region', { name: 'Run history' })
    const runList = history.getByRole('region', { name: 'Saved runs' })
    await runList.getByRole('button', { name: /visual-run-3/ }).waitFor()
    await runList.getByRole('button', { name: 'Load more runs' }).click()
    await runList.getByRole('button', { name: /visual-run-1/ }).waitFor()
    const quickRun = runList.getByRole('textbox', { name: 'Open by Run ID' })
    await quickRun.fill('visual-run-1')
    await quickRun.press('Enter')
    const journal = history.getByRole('region', { name: 'Run journal' })
    const timeline = journal.getByRole('region', { name: 'Journal events' })
    await journal.getByText('visual-run-1', { exact: true }).waitFor()
    await journal.getByRole('button', { name: 'Copy run ID' }).click()
    await journal.getByText('Run ID copied').waitFor()
    if (await page.evaluate(() => navigator.clipboard.readText()) !== 'visual-run-1') throw new Error('History copied the wrong Run ID')
    await journal.getByText('Run output', { exact: true }).click()
    await journal.getByText(/"quality": "verified"/).waitFor()
    await timeline.getByText('Run complete', { exact: true }).waitFor()
    if (await timeline.getByText('Run started', { exact: true }).count() !== 0) throw new Error('Initial history did not request the recent event window')
    await timeline.getByRole('button', { name: 'Read older events' }).click()
    await timeline.getByText('Run started', { exact: true }).waitFor()
    await timeline.getByText('Run complete', { exact: true }).waitFor()
    await page.waitForFunction(() => window.__canvasSmoke.journalQueries.some(query => query.runId === 'visual-run-1' && query.window === 'recent' && query.beforeSeq === 6))
    await page.evaluate(() => {
      const original = URL.createObjectURL.bind(URL)
      URL.createObjectURL = blob => {
        if (blob instanceof Blob && blob.type.startsWith('application/x-ndjson')) {
          void blob.text().then(text => { window.__downloadedJournal = text })
        }
        return original(blob)
      }
    })
    const download = page.waitForEvent('download')
    await journal.getByText('Audit and regression', { exact: true }).click()
    await journal.getByRole('button', { name: 'Download raw JSONL' }).click()
    if ((await download).suggestedFilename() !== 'workflow-visual-run-1.jsonl') throw new Error('Unexpected journal filename')
    await page.waitForFunction(() => typeof window.__downloadedJournal === 'string')
    const lines = (await page.evaluate(() => window.__downloadedJournal)).trim().split('\n').map(line => JSON.parse(line))
    if (lines.length !== 106 || lines[0].checkpointSeq !== 105 || lines[0].type !== 'run.snapshot'
      || lines[0].ref !== 'research-signal' || lines[105].type !== 'run.completed'
      || lines.filter(item => item.type === 'checkpoint.committed').length !== 100) throw new Error('Journal export omitted paginated or hidden events')
    if ((await page.evaluate(() => window.__canvasSmoke.traceEventOnly)) !== 1) throw new Error('Later export pages requested the full run snapshot')

    await runList.getByRole('combobox', { name: 'Status' }).selectOption('failed')
    await runList.getByRole('button', { name: /visual-run-2/ }).waitFor()
    if (await runList.locator('.wf-history-row').count() !== 1) throw new Error('Run history status filter did not apply')
    await runList.getByRole('button', { name: /visual-run-2/ }).click()
    const failureSummary = journal.getByRole('region', { name: 'Failure summary' })
    await failureSummary.getByText('DSH_TOOL_FAILED: visual fixture failure', { exact: true }).waitFor()
    if (await timeline.locator('details[data-seq="1"]').count() !== 0) throw new Error('Old failure should be outside the recent window')
    await failureSummary.getByRole('button', { name: 'Open failure event' }).click()
    await timeline.locator('details[open][data-seq="1"][data-focused="true"]').getByText('Node failed', { exact: true }).waitFor()
    await page.waitForFunction(() => window.__canvasSmoke.journalQueries.some(query => query.runId === 'visual-run-2' && query.window === 'recent'
      && query.failuresOnly === true && query.nodeId === 'research'))
    await timeline.getByRole('combobox', { name: 'Event node' }).selectOption('start')
    await timeline.getByText('No events match these filters', { exact: true }).waitFor()
    await timeline.getByRole('combobox', { name: 'Event node' }).selectOption('')
    await timeline.getByText('Run failed', { exact: true }).waitFor()
    await journal.getByRole('button', { name: /Inspect failed node research/ }).click()
    await journal.getByRole('region', { name: 'Executed graph' }).waitFor()
    await journal.locator('.wf-frozen-node.selected').getByText('Collect evidence').waitFor()
    await journal.getByText('Audit and regression', { exact: true }).click()
    await journal.getByRole('button', { name: 'Save regression case' }).click()
    const caseDialog = page.getByRole('dialog', { name: 'Save regression case' })
    await caseDialog.getByRole('button', { name: 'Download test case' }).waitFor()
    await page.waitForFunction(() => window.__canvasSmoke.calls.exportCase === 1 && document.querySelector('dialog[open] textarea')?.value?.includes('agent-dag-workflow.case/v1'))
    const caseJson = JSON.parse(await caseDialog.getByRole('textbox', { name: 'Regression case JSON' }).inputValue())
    if (caseJson.format !== 'agent-dag-workflow.case/v1' || caseJson.source.runId !== 'visual-run-2'
      || caseJson.expected.status !== 'failed' || caseJson.inputs.fail !== true) throw new Error('Historical run did not produce a matching case')
    const caseDownload = page.waitForEvent('download')
    await caseDialog.getByRole('button', { name: 'Download test case' }).click()
    if ((await caseDownload).suggestedFilename() !== 'visual-run-2.case.json') throw new Error('Regression case download filename changed')
    await caseDialog.getByText('Compare with the CLI', { exact: true }).click()
    await caseDialog.getByText(/The exact baseline contains raw workflow values/).waitFor()
    await caseDialog.getByRole('button', { name: 'Copy compare command' }).click()
    await caseDialog.getByText('Compare command copied').waitFor()
    const command = await page.evaluate(() => navigator.clipboard.readText())
    if (command !== 'adw case compare ./visual-run-2.case.json --base ./visual-run-2.baseline.workflow.json --candidate ./candidate.workflow.json') throw new Error('CLI command was not runnable against the provided file names')
    const baselineDownload = page.waitForEvent('download')
    await caseDialog.getByRole('button', { name: 'Download baseline workflow' }).click()
    if ((await baselineDownload).suggestedFilename() !== 'visual-run-2.baseline.workflow.json') throw new Error('Baseline download did not match copied command')
    await caseDialog.getByRole('button', { name: 'Close', exact: true }).click()
    await journal.getByRole('button', { name: 'Export shareable evidence' }).click()
    const evidenceDialog = page.getByRole('dialog', { name: 'Export run evidence' })
    const evidence = evidenceDialog.getByRole('textbox', { name: 'Evidence JSON' })
    await page.waitForFunction(() => window.__canvasSmoke.calls.exportEvidence === 1 && document.querySelector('dialog[open] textarea')?.value?.includes('agent-dag-workflow.evidence/v1'))
    const initialEvidence = JSON.parse(await evidence.inputValue())
    if (initialEvidence.artifacts !== undefined || initialEvidence.inputs.fail !== true) throw new Error('Default evidence did not exclude artifact content')
    await evidenceDialog.getByRole('textbox', { name: 'Fields to redact, comma-separated' }).fill('fail')
    await evidenceDialog.getByRole('checkbox', { name: 'Include captured artifact content' }).check()
    if (!(await evidenceDialog.getByRole('button', { name: 'Download evidence' }).isDisabled())) throw new Error('Evidence export ignored unapplied redaction options')
    await evidenceDialog.getByRole('button', { name: 'Refresh preview' }).click()
    await page.waitForFunction(() => document.querySelector('dialog[open] textarea')?.value?.includes('[redacted]'))
    const refreshedEvidence = JSON.parse(await evidence.inputValue())
    if (refreshedEvidence.inputs.fail !== '[redacted]' || refreshedEvidence.artifacts?.length !== 1) throw new Error('Evidence options did not reach the host export')
    const evidenceDownload = page.waitForEvent('download')
    await evidenceDialog.getByRole('button', { name: 'Download evidence' }).click()
    if ((await evidenceDownload).suggestedFilename() !== 'visual-run-2.evidence.json') throw new Error('Evidence filename mismatch')
    await evidenceDialog.getByRole('button', { name: 'Close', exact: true }).click()
    await journal.getByRole('button', { name: 'Set as comparison baseline' }).click()
    await runList.getByRole('combobox', { name: 'Status' }).selectOption('completed')
    await runList.getByRole('button', { name: /visual-run-1/ }).click()
    await journal.getByRole('button', { name: 'Compare with baseline' }).click()
    const comparison = page.getByRole('dialog', { name: 'Compare saved runs' })
    const comparedStatus = comparison.getByRole('row', { name: /Status.*Run failed.*Run complete/ })
    await comparedStatus.waitFor()
    await comparison.getByText('Run inputs', { exact: false }).click()
    await comparison.getByText(/"fail": true/).waitFor()
    await comparison.getByRole('button', { name: 'Close', exact: true }).click()
    await page.evaluate(() => window.__canvasSmoke.seedHistoryViews())
    await quickRun.fill('visual-missing')
    await quickRun.press('Enter')
    await journal.getByText('Check the Run ID and use a session that can access the saved run.', { exact: true }).waitFor()
    await quickRun.fill('visual-interrupted')
    await quickRun.press('Enter')
    await journal.getByText('Interrupted', { exact: true }).waitFor()
    await journal.getByRole('button', { name: 'Continue this run' }).waitFor()
    await quickRun.fill('visual-recorded-replay')
    await quickRun.press('Enter')
    await journal.getByText('Recorded replay from', { exact: true }).waitFor()
    await journal.getByRole('button', { name: 'visual-run-1', exact: true }).click()
    await journal.getByText('visual-run-1', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Back to Canvas' }).click()
    if (JSON.parse(await input.inputValue()).message !== 'Personal starter run') throw new Error('Browsing prior runs changed the active draft inputs')
    await result.getByText('visual-run-3', { exact: true }).waitFor()
    await result.getByRole('button', { name: 'Markdown', exact: true }).click()
    await result.getByText('Personal starter run', { exact: true }).waitFor()
    await result.getByRole('button', { name: 'Table', exact: true }).click()
    await result.getByRole('rowheader', { name: 'message' }).waitFor()
    await result.getByRole('button', { name: 'JSON', exact: true }).click()

    await page.getByText('Input presets', { exact: true }).click()
    await page.getByRole('textbox', { name: 'Preset name' }).fill('Repeat report')
    await page.getByRole('button', { name: 'Save inputs on this device' }).click()
    await input.fill('{}')
    await page.getByRole('button', { name: 'Repeat report', exact: true }).click()
    if (JSON.parse(await input.inputValue()).message !== 'Personal starter run') throw new Error('Saved preset did not restore the run inputs')
    await page.getByRole('button', { name: 'Clear saved presets' }).click()
    await page.getByRole('button', { name: 'Repeat report', exact: true }).waitFor({ state: 'detached' })
    await page.getByRole('textbox', { name: 'Preset name' }).press('Escape')
    if (!(await page.getByText('Input presets', { exact: true }).evaluate(element => document.activeElement === element && !element.parentElement.open))) throw new Error('Escape did not close the preset menu and restore focus')

    await page.getByRole('combobox', { name: 'Select workflow draft' }).selectOption('research-signal')
    await page.getByRole('button', { name: 'Favorite workflow' }).click()
    await page.getByRole('button', { name: 'Remove workflow favorite' }).waitFor()
    const workflowId = page.getByRole('textbox', { name: 'Workflow ID' })
    if (!(await workflowId.evaluate(element => element.readOnly))) throw new Error('Saved workflow ID is still editable')

    await name.fill('Submitted to delayed save')
    await page.evaluate(() => { window.__canvasSmoke.delaySave = true })
    const saveButton = page.getByRole('button', { name: 'Save', exact: true })
    await saveButton.click()
    await page.waitForFunction(() => typeof window.__canvasSmoke.releaseSave === 'function')
    await name.fill('Typed after save started')
    await page.evaluate(() => { window.__canvasSmoke.delaySave = false; window.__canvasSmoke.releaseSave() })
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Save' && !button.disabled))
    if (await name.inputValue() !== 'Typed after save started' || await studio.locator('[data-state="dirty"]').count() !== 1) {
      throw new Error('Late save acknowledgment overwrote newer edits or cleared dirty state')
    }
    if ((await page.evaluate(() => window.__canvasSmoke.savedName)) !== 'Submitted to delayed save') throw new Error('Save snapshot did not match submitted edits')
    await saveButton.click()
    await page.locator('[data-state="saved"]').waitFor()
    if ((await page.evaluate(() => window.__canvasSmoke.savedName)) !== 'Typed after save started') throw new Error('Follow-up save used a stale CAS revision')

    await name.fill('Snapshot chosen for publication')
    await page.evaluate(() => { window.__canvasSmoke.delayPublish = true })
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm publication', exact: true }).click()
    await page.waitForFunction(() => typeof window.__canvasSmoke.releasePublish === 'function')
    await name.fill('Typed while publication was pending')
    await page.evaluate(() => { window.__canvasSmoke.delayPublish = false; window.__canvasSmoke.releasePublish() })
    await page.getByRole('status').getByText('Published revision 1. Newer edits remain in the draft.').waitFor()
    if (await name.inputValue() !== 'Typed while publication was pending' || await studio.locator('[data-state="dirty"]').count() !== 1
      || (await page.evaluate(() => window.__canvasSmoke.publishedName)) !== 'Snapshot chosen for publication') {
      throw new Error('Late publication acknowledged a different snapshot or marked an edited draft published')
    }

    const beforeEdit = await name.inputValue()
    await name.fill('Edited for comparison')
    await page.getByText('Workflow actions', { exact: true }).click()
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    if (await name.inputValue() !== beforeEdit) throw new Error('Undo did not restore the previous workflow')
    await page.getByRole('button', { name: 'Redo', exact: true }).click()
    if (await name.inputValue() !== 'Edited for comparison') throw new Error('Redo did not restore the workflow edit')
    await page.getByText('Workflow actions', { exact: true }).click()
    await page.locator('.react-flow__node[data-id="research"]').click()
    await page.getByRole('textbox', { name: 'New input name' }).fill('topic')
    await page.getByRole('button', { name: 'Add input binding' }).click()
    await page.getByRole('combobox', { name: 'Source for topic' }).selectOption('output:start')
    const bindingPath = page.getByRole('textbox', { name: 'Field path (JSON array)' })
    await bindingPath.fill('["value"]')
    await bindingPath.press('Tab')

    await input.fill('{}')
    await page.getByRole('button', { name: 'Published revisions' }).click()
    const revisions = page.getByRole('dialog', { name: 'Published revisions' })
    await revisions.getByRole('combobox', { name: 'Exact revision' }).selectOption('1')
    await revisions.getByRole('heading', { name: /Archived research revision.*research-signal@1/ }).waitFor()
    await revisions.getByRole('button', { name: 'Compare with current draft' }).click()
    await revisions.getByText('Current draft JSON').waitFor()
    await revisions.getByRole('button', { name: 'Run published revision' }).click()
    await revisions.getByText('Archived topic is required.', { exact: false }).waitFor()
    await revisions.getByRole('button', { name: 'Input form', exact: true }).click()
    const archiveForm = page.getByRole('dialog', { name: 'Inputs for research-signal@1' })
    await archiveForm.getByRole('button', { name: 'Apply inputs' }).click()
    await archiveForm.getByText('This input is required', { exact: true }).waitFor()
    if (!(await archiveForm.getByRole('textbox', { name: /Archived topic/ }).evaluate(element => document.activeElement === element))) throw new Error('Invalid form did not focus the required field')
    await archiveForm.getByRole('textbox', { name: /Archived topic/ }).fill('archive failure')
    await archiveForm.getByRole('combobox', { name: 'Value mode for Optional note' }).selectOption('value')
    await archiveForm.getByRole('combobox', { name: 'Include flag' }).selectOption('false')
    await archiveForm.getByRole('combobox', { name: 'Value mode for Nullable fallback' }).selectOption('null')
    await archiveForm.getByRole('button', { name: 'Apply inputs' }).click()
    const exactInputs = JSON.parse(await revisions.getByRole('textbox', { name: 'Published run input JSON' }).inputValue())
    if (exactInputs.archivedTopic !== 'archive failure' || exactInputs.note !== '' || exactInputs.flag !== false || exactInputs.fallback !== null
      || Object.hasOwn(exactInputs, 'unselected')) {
      throw new Error('Published input form did not use the exact revision schema')
    }
    await revisions.getByRole('button', { name: 'Run published revision' }).click()
    await journal.getByText('visual-run-4', { exact: true }).waitFor()
    await journal.getByText('research-signal@1', { exact: true }).waitFor()
    await journal.getByRole('heading', { name: 'Archived research revision', exact: true }).waitFor()
    await journal.getByRole('region', { name: 'Executed graph' }).getByText('Archived release check').waitFor()
    await journal.getByRole('button', { name: /Inspect failed node archived-check/ }).click()
    await journal.locator('.wf-frozen-node.selected').getByText('Archived release check').waitFor()
    await runList.getByRole('button', { name: 'More filters' }).click()
    await runList.getByRole('textbox', { name: 'Find a run' }).fill('visual-run-4')
    await runList.getByRole('spinbutton', { name: 'Exact revision' }).fill('1')
    await runList.getByRole('combobox', { name: 'Origin' }).selectOption('host')
    await runList.getByRole('button', { name: 'Apply filters' }).click()
    await runList.getByRole('button', { name: /visual-run-4/ }).waitFor()
    if (await runList.locator('.wf-history-row').count() !== 1) throw new Error('Run ID, revision, and source filters did not narrow the list')
    await page.getByRole('button', { name: 'Back to Canvas' }).click()
    if (await name.inputValue() !== 'Edited for comparison' || await input.inputValue() !== '{}'
      || await page.locator('main.wf-canvas .react-flow__node[data-id="archived-check"]').count() !== 0) {
      throw new Error('Viewing an immutable run replaced or annotated the editable draft')
    }

    await input.fill('{"slow":true}')
    await page.evaluate(() => { window.__canvasSmoke.failTrace = true })
    await testRun.click()
    await result.getByText('visual-run-5', { exact: true }).waitFor()
    await page.getByText('Waiting to reconnect to the run journal').waitFor()
    await page.getByRole('button', { name: 'Run history', exact: true }).click()
    await runList.getByRole('button', { name: /visual-run-5/ }).click()
    await page.evaluate(() => { window.__canvasSmoke.failTrace = false; window.dispatchEvent(new Event('online')) })
    await journal.getByText('visual-run-5', { exact: true }).waitFor()
    await page.evaluate(() => { window.__canvasSmoke.delayCancel = true })
    await journal.getByRole('button', { name: 'Stop run' }).click()
    await journal.getByText('Stop requested…', { exact: true }).waitFor()
    await journal.getByText('Waiting for the Host to finish or stop the current action.', { exact: true }).waitFor()
    await page.evaluate(() => { window.__canvasSmoke.delayCancel = false; window.__canvasSmoke.releaseCancel() })
    await journal.getByText('Canceled', { exact: true }).waitFor()

    await page.getByRole('button', { name: 'Back to Canvas' }).click()
    await input.fill('{"paused":true}')
    await testRun.click()
    await page.getByRole('button', { name: 'Review paused run' }).click()
    await journal.getByText('Needs attention', { exact: true }).waitFor()
    await journal.getByRole('combobox', { name: 'research' }).selectOption('retry')
    await journal.getByRole('combobox', { name: 'approve' }).selectOption('fail')
    await journal.getByRole('button', { name: 'Continue this run' }).click()
    await journal.getByText('Run complete', { exact: true }).first().waitFor()
    await journal.getByText('visual-run-6', { exact: true }).waitFor()
    const decisions = await page.evaluate(() => window.__canvasSmoke.decisions)
    if (decisions.research !== 'retry' || decisions.approve !== 'fail') throw new Error('History did not send independent node resolutions')
    await journal.getByRole('button', { name: 'New run with these inputs' }).click()
    const newRunDialog = page.getByRole('dialog', { name: 'New run with these inputs' })
    const newRunInputs = newRunDialog.getByRole('textbox', { name: 'New run input JSON' })
    if (JSON.parse(await newRunInputs.inputValue()).paused !== true || !(await newRunInputs.evaluate(element => document.activeElement === element))) {
      throw new Error('Historical inputs were not available for a clearly scoped new run')
    }
    await newRunDialog.getByText('Run may call real Host tools or agents.', { exact: true }).waitFor()
    await newRunInputs.fill('{"paused":false,"newFromHistory":true}')
    await newRunDialog.getByRole('button', { name: 'Start new run' }).click()
    await journal.getByText('visual-run-7', { exact: true }).waitFor()
    await journal.getByRole('region', { name: 'Executed graph' }).waitFor()
    await page.getByRole('button', { name: 'Back to Canvas' }).click()
    if (JSON.parse(await input.inputValue()).paused !== true) throw new Error('Starting another run replaced the editor inputs')
    if (!confirmations.some(message => message.includes('real host tools')) || !confirmations.some(message => message.includes('repeat an external action'))) {
      throw new Error('Live effects and retry confirmations were not presented')
    }

    const unacknowledged = '{"first":"temporary-content","second":true}'
    await page.evaluate(() => { window.__canvasSmoke.reopen(); window.__canvasSmoke.loseAdmissionOnce = true })
    await page.waitForFunction(() => document.querySelector('input[aria-label="Workflow name"]').value === 'Research quality signal')
    await input.fill(unacknowledged)
    await testRun.click()
    await page.waitForFunction(() => window.__canvasSmoke.calls.runDraft === 8)
    const pending = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.endsWith('pending-run-starts'))?.[1])
    if (!pending || pending.includes('temporary-content') || JSON.parse(pending).length !== 1) throw new Error('Pending admission did not retain only a digest and request ID')
    await page.evaluate(() => window.__canvasSmoke.reopen())
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Run input JSON"]').value === '{}')
    await input.fill('{"second":true,"first":"temporary-content"}')
    await testRun.click()
    await result.getByText('visual-run-8', { exact: true }).waitFor()
    if ((await page.evaluate(() => window.__canvasSmoke.calls.runDraft)) !== 8) throw new Error('Reopening after a lost response duplicated a run')

    await input.fill('{"slow":true}')
    await testRun.click()
    await result.getByText('visual-run-9', { exact: true }).waitFor()
    await page.locator('main.wf-canvas .react-flow__node[data-id="research"]').click()
    await page.getByRole('button', { name: 'Delete node' }).click()
    await page.evaluate(() => window.__canvasSmoke.failRunning('visual-run-9'))
    await result.getByRole('button', { name: /Inspect failed node research/ }).click()
    await journal.locator('.wf-frozen-node.selected').getByText('Collect evidence').waitFor()
    await page.getByRole('button', { name: 'Back to Canvas' }).click()
    if (await page.locator('main.wf-canvas .react-flow__node[data-id="research"]').count() !== 0) throw new Error('Failure jump restored a node into the edited draft')

    await page.getByText('Input presets', { exact: true }).click()
    await page.getByLabel('Import input JSON').setInputFiles({ name: 'import.json', mimeType: 'application/json', buffer: Buffer.from('{"example":"imported"}') })
    await page.waitForFunction(() => JSON.parse(document.querySelector('textarea[aria-label="Run input JSON"]').value).example === 'imported')
    await page.getByText('Input presets', { exact: true }).click()
    await page.getByText('Workflow actions', { exact: true }).click()
    await page.getByRole('button', { name: 'Duplicate workflow' }).click()
    if (await name.inputValue() !== 'Research quality signal copy') throw new Error('Duplicate did not become a separate editable draft')
    const workflowDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export workflow JSON' }).click()
    if ((await workflowDownload).suggestedFilename() !== 'research-signal-copy.workflow.json') throw new Error('Duplicate export did not use the new workflow ID')
    await page.getByLabel('Import workflow JSON').setInputFiles({ name: 'workflow.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      apiVersion: 'workflow.gm-hz.dev/v1', kind: 'WorkflowTemplate', metadata: { id: 'imported-personal', name: 'Imported personal workflow' },
      spec: { inputSchema: {}, outputSchema: {}, nodes: [], edges: [], outputs: {} },
    })) })
    await page.waitForFunction(() => document.querySelector('input[aria-label="Workflow name"]').value === 'Imported personal workflow')

    await page.evaluate(() => {
      localStorage.removeItem('agent-dag-workflow:recovery:visual-session')
      window.__canvasSmoke.seedHomeViews()
      window.__canvasSmoke.openHome()
    })
    const home = page.getByRole('main', { name: 'My workflows' })
    await home.getByText(/Current DSH session.*visual-session/).click()
    await home.getByText('/fixture/workflows.db', { exact: true }).waitFor()
    await home.getByRole('button', { name: 'Open run visual-home-active' }).waitFor()
    await home.getByRole('button', { name: 'Open run visual-home-decision' }).waitFor()
    await home.getByText(/Interrupted.*visual-home-interrupted/).waitFor()
    await home.getByRole('button', { name: 'Open run visual-home-interrupted' }).click()
    await journal.getByText('visual-home-interrupted', { exact: true }).waitFor()
    await journal.getByRole('button', { name: 'Continue this run' }).waitFor()
    await page.getByRole('button', { name: 'My workflows', exact: true }).click()

    const launchFavorite = home.getByRole('button', { name: /Run favorite .* at revision 1/ })
    await launchFavorite.click()
    const quickRevision = page.getByRole('dialog', { name: 'Run published revision' })
    const quickInputs = quickRevision.getByRole('textbox', { name: 'Published run input JSON' })
    await quickRevision.getByRole('heading', { name: /Archived research revision.*research-signal@1/ }).waitFor()
    await quickInputs.fill('{"archivedTopic":"Remembered request"}')
    await quickRevision.getByRole('button', { name: 'Remember these revision inputs' }).click()
    await quickRevision.getByRole('button', { name: 'Close', exact: true }).click()
    await launchFavorite.click()
    await quickInputs.waitFor()
    if (await quickInputs.inputValue() !== '{}') throw new Error('Quick launch exposed saved revision inputs without an explicit choice')
    await quickRevision.getByRole('button', { name: 'Use last saved revision inputs' }).click()
    if (JSON.parse(await quickInputs.inputValue()).archivedTopic !== 'Remembered request') throw new Error('Quick launch did not reload inputs for exact revision')
    await quickRevision.getByRole('button', { name: 'Run published revision', exact: true }).click()
    await journal.getByText('research-signal@1', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'My workflows', exact: true }).click()

    await home.getByRole('button', { name: 'Start with a runnable example' }).click()
    await input.waitFor()
    if (JSON.parse(await input.inputValue()).message !== 'Hello, DSH Workflow') throw new Error('Home did not open the echo example with its input')
    await page.getByRole('button', { name: 'My workflows', exact: true }).click()

    await home.getByRole('button', { name: 'Open order example' }).click()
    await page.waitForFunction(() => document.querySelector('input[aria-label="Workflow name"]').value === 'Order normalization')
    if (JSON.parse(await input.inputValue()).orders.length !== 3) throw new Error('Order starter did not load the canonical input fixture')
    await testRun.click()
    await result.getByText(/"total": 100/).waitFor()
    await page.locator('main.wf-canvas .react-flow__node[data-id="normalize"]').click()
    const maxOperations = page.getByRole('spinbutton', { name: 'MAXOPERATIONS' })
    if (await maxOperations.inputValue() !== '10000') throw new Error('Canonical order node configuration unavailable in Canvas')
    await maxOperations.fill('')
    await page.getByText('Advanced · raw JSON and output contract', { exact: true }).click()
    const nodeConfig = page.getByRole('textbox', { name: /Raw node configuration/ })
    if (Object.hasOwn(JSON.parse(await nodeConfig.inputValue()), 'maxOperations')) throw new Error('Clearing the numeric field wrote a number instead of removing the property')

    const authoringCalls = await page.evaluate(() => ({ ...window.__canvasSmoke.calls }))
    await nodeConfig.fill('{"unfinished":')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await nodeConfig.press('Control+s')
    await page.getByRole('button', { name: 'Validate', exact: true }).click()
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await testRun.click()
    if (!(await nodeConfig.evaluate(element => document.activeElement === element && element.getAttribute('aria-invalid') === 'true'))) throw new Error('Unfinished editor field was not focused and marked invalid')
    const blockedCalls = await page.evaluate(() => window.__canvasSmoke.calls)
    for (const action of ['createDraft', 'updateDraft', 'validate', 'publish', 'runDraft']) {
      if (blockedCalls[action] !== authoringCalls[action]) throw new Error('Unfinished editor leaked a stale action: ' + action)
    }

    await page.getByRole('button', { name: 'Close workflow Canvas' }).click()
    const closeDraft = page.getByRole('dialog', { name: 'Unsaved draft changes' })
    await closeDraft.getByRole('button', { name: 'Keep for later' }).click()
    await page.getByRole('button', { name: 'Reopen personal workflows' }).click()
    await page.getByText('Unsaved changes restored', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Review unfinished fields' }).click()
    if (await nodeConfig.inputValue() !== '{"unfinished":') throw new Error('Kept draft did not restore its unfinished editor text')
    await nodeConfig.fill('{"language":"json.expr@1","source":"input"}')
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    const publishDialog = page.getByRole('dialog', { name: 'Publish an immutable revision?' })
    await publishDialog.waitFor()
    await page.keyboard.press('Escape')
    await publishDialog.waitFor({ state: 'detached' })

    const nodeTab = page.getByRole('tab', { name: /Workflow nodes/ })
    await nodeTab.press('ArrowRight')
    const toolsTab = page.getByRole('tab', { name: /Agent tools/ })
    if (!(await toolsTab.evaluate(element => document.activeElement === element && element.getAttribute('aria-selected') === 'true'))) throw new Error('Palette tabs were not keyboard-selectable')
    await toolsTab.press('ArrowLeft')
    const condition = page.locator('.wf-palette-node').filter({ has: page.getByText('Condition', { exact: true }) })
    await condition.click()
    await condition.click()
    const placed = await page.locator('.react-flow__node[data-id="condition"], .react-flow__node[data-id="condition-2"]').evaluateAll(elements => elements.map(element => element.style.transform))
    if (placed.length !== 2 || placed[0] === placed[1]) throw new Error('Repeated additions overlap in the editor')
    await page.getByRole('heading', { name: 'condition-2', exact: true }).waitFor()

    await page.getByRole('button', { name: 'Close workflow Canvas' }).click()
    await closeDraft.getByRole('button', { name: 'Discard changes' }).click()
    await page.getByRole('button', { name: 'Reopen personal workflows' }).click()
    await home.waitFor()
    if (await page.getByText('Unsaved changes restored', { exact: true }).count() > 0) throw new Error('Discarded draft reappeared from local recovery')
    await page.getByRole('button', { name: 'Triggers & delivery', exact: true }).click()
    const schedules = page.getByRole('region', { name: 'Time schedules' })
    await schedules.getByText('Next scheduled run', { exact: true }).waitFor()
    await schedules.getByText('Last scheduler check', { exact: true }).waitFor()
    await schedules.getByText('INGRESS_WORKFLOW_INPUT_INVALID', { exact: true }).waitFor()
    await schedules.getByRole('button', { name: 'Run schedule trial' }).click()
    await schedules.getByText('Scheduled run started', { exact: true }).waitFor()
    await schedules.getByRole('button', { name: 'View run journal' }).click()
    await journal.getByText('visual-schedule-trial', { exact: true }).waitFor()
    await page.evaluate(() => window.__canvasSmoke.openHome())
    await home.getByRole('region', { name: 'Recent finished runs' }).getByRole('button', { name: 'Review run visual-schedule-trial' }).click()
    await journal.getByText('visual-schedule-trial', { exact: true }).waitFor()

    if (consoleErrors.length > 0) throw new Error('browser console errors: ' + consoleErrors.join(' | '))
  }`)
  process.stdout.write('Canvas browser smoke passed: personal home and exact launches, unfinished editor protection, draft recovery, run admission, frozen graph, journal navigation, evidence and regression cases.\n')
} finally {
  try { runCli('close') } catch { /* preserve the original failure */ }
  stopServer(server)
}

function runCli(...args) {
  const result = spawnSync(pnpm, ['exec', 'playwright-cli', '--session', session, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  })
  if (result.status !== 0) {
    throw new Error(`playwright-cli ${args[0]} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const candidate = createServer()
    candidate.once('error', reject)
    candidate.listen(0, '127.0.0.1', () => {
      const address = candidate.address()
      if (typeof address === 'string' || address === null) {
        candidate.close(() => reject(new Error('could not allocate a Canvas fixture port')))
        return
      }
      candidate.close(error => error === undefined ? resolve(address.port) : reject(error))
    })
  })
}

async function waitForServer(target, child) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Canvas fixture server exited early\n${serverOutput}`)
    try {
      const response = await fetch(target)
      if (response.ok) return
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Canvas fixture server did not become ready\n${serverOutput}`)
}

function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill('SIGTERM')
    else process.kill(-child.pid, 'SIGTERM')
  } catch { /* already stopped */ }
}
