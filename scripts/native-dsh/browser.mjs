export async function nativeCanvasSmoke(page, outputFile, evidenceFile) {
  async function whenVisible(locator) {
    try { await locator.waitFor({ state: 'visible', timeout: 2_500 }); return true }
    catch { return false }
  }

  const intro = page.getByRole('button', { name: /^(继续|Continue)$/ }).and(page.locator('button:enabled')).first()
  const welcome = page.getByRole('dialog', { name: /^(开始使用|Get started)$/ })
  const closeWelcome = welcome.getByRole('button', { name: /^(关闭|Close)$/ })
  const apiKeyPrompt = page.getByRole('dialog', { name: /添加一个 API Key 开始使用|Add an API key to get started/i })
  const skipApiKey = apiKeyPrompt.getByRole('button', { name: /^(稍后配置|Set up later|Configure later|Skip for now)$/i })
  async function dismissIntro() {
    for (const button of [closeWelcome, skipApiKey, intro]) {
      if (!await button.isVisible()) continue
      try { await button.click({ timeout: 1_500 }) } catch { /* the onboarding UI can transition between steps */ }
    }
  }
  async function clickAfterIntro(locator) {
    let error
    for (let attempt = 0; attempt < 4; attempt++) {
      await dismissIntro()
      try { await locator.click({ timeout: 3_500 }); return }
      catch (cause) { error = cause }
    }
    throw error
  }
  await dismissIntro()
  const workspace = page.getByRole('treeitem', { name: 'workspace', exact: true })
  await workspace.waitFor({ timeout: 20_000 })
  if ((await workspace.getAttribute('aria-expanded')) !== 'true') await clickAfterIntro(workspace)
  const owner = page.getByRole('treeitem', { name: /^(未命名|Untitled)/ }).first()
  if (await whenVisible(owner)) await clickAfterIntro(owner)

  const launcher = page.getByRole('button', { name: /^(工作流|Workflow)$/ })
  await clickAfterIntro(launcher)
  await page.getByRole('button', { name: /从可运行示例开始|Start with a runnable example/ }).click()
  const input = page.getByRole('textbox', { name: /运行输入 JSON|Run input JSON/ })
  await input.fill(JSON.stringify({ message: 'Native DSH package smoke' }))
  await page.getByRole('button', { name: /^(保存|Save)$/ }).click()
  await page.getByRole('button', { name: /^(▶ ?)?(运行草稿|Run draft|试运行|Test run)$/ }).click()
  await page.getByText(/"message": "Native DSH package smoke"/).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: /^(关闭工作流画布|Close workflow Canvas)$/ }).click()
  await launcher.click()
  await page.getByRole('button', { name: /^(运行历史|Run history)$/ }).click()

  const history = page.getByRole('region', { name: /^(运行历史|Run history)$/ })
  const runs = history.locator('.wf-history-row')
  await runs.first().waitFor({ timeout: 20_000 })
  if (await runs.count() !== 1) throw new Error('Native run history did not stay scoped to the selected session')
  await runs.first().click()
  const journal = history.getByRole('region', { name: /^(运行日志|Run journal)$/ })
  await journal.locator('.wf-history-status[data-status=completed]').waitFor({ timeout: 20_000 })
  await journal.getByText(/^(运行结果|Run output)$/).click()
  await journal.getByText(/"message": "Native DSH package smoke"/).first().waitFor()
  const download = page.waitForEvent('download')
  const audit = journal.getByText(/^(审计与回归|Audit and regression)$/)
  if (await audit.count() > 0) await audit.click()
  await journal.getByRole('button', { name: /下载原始 JSONL|Download raw JSONL/ }).click()
  await (await download).saveAs(outputFile)

  await journal.getByRole('button', { name: /^(导出可分享证据|Export shareable evidence)$/ }).click()
  const modal = page.getByRole('dialog', { name: /^(导出运行证据|Export run evidence)$/ })
  await modal.getByRole('textbox', { name: /按字段名脱敏|Fields to redact/ }).fill('message')
  await modal.getByRole('checkbox', { name: /包含已捕获的产物内容|Include captured artifact content/ }).check()
  await modal.getByRole('button', { name: /刷新预览|Refresh preview/ }).click()
  const evidenceDownload = page.waitForEvent('download')
  await modal.getByRole('button', { name: /下载证据|Download evidence/ }).click()
  await (await evidenceDownload).saveAs(evidenceFile)
}
