---
layout: home
description: 安装 Agent DAG Workflow，运行第一个工作流，查看执行记录，再接入 Codex、MCP 或现有应用。
---

<div class="workflow-home">

<section class="workflow-hero" aria-labelledby="workflow-title">
  <div class="workflow-intro">
    <h1 id="workflow-title">Agent DAG<br /> Workflow</h1>
    <p class="workflow-lead">把 Agent 的工具调用组织成可重复运行的工作流。</p>
    <p>用一份 JSON 定义步骤和依赖。运行时负责调度、保存执行记录和恢复，工具和权限由你的宿主管理。</p>
    <div class="workflow-actions">

[运行第一个工作流](#first-run) [查看示例](/examples/)

  </div>
  </div>

  <figure class="workflow-example">
    <figcaption>示例 <code>script-transform-demo@1</code></figcaption>
    <ol>
      <li><code>start</code><span>读取三笔订单</span></li>
      <li><code>normalize</code><span>整理客户名，计算订单总额</span></li>
      <li><code>end</code><span>返回整理结果</span></li>
    </ol>
    <div class="workflow-output">
      <span>运行结果节选</span>
      <pre><code>{"status": "completed", "outputs": {"total": 100}}</code></pre>
    </div>
  </figure>
</section>

<section class="workflow-section" aria-labelledby="first-run">

<h2 id="first-run">本地运行第一个工作流</h2>

需要 Node.js 22.19 或更新版本。下面的 Bash 命令安装 npm 包，并使用包内的订单示例。运行只需本地 SQLite，无需模型账号或 API 密钥。

```bash
mkdir adw-quickstart
cd adw-quickstart
npm install @gm-hz/agent-dag-workflow

examples=./node_modules/@gm-hz/agent-dag-workflow/examples
npm exec -- adw validate "$examples/script-transform.workflow.json"
npm exec -- adw draft put "$examples/script-transform.workflow.json"
npm exec -- adw publish script-transform-demo --expected 1
npm exec -- adw run script-transform-demo@1 --input "$examples/inputs/script-transform.json"
```

运行成功后，`data.status` 会显示 `completed`，`data.outputs.total` 为 `100`。在同一目录运行下列命令，把 `RUN_ID` 换成结果里的 `data.runId`，即可查看各步骤的执行记录。

```bash
npm exec -- adw trace RUN_ID --events
```

</section>

<section class="workflow-section" aria-labelledby="integrations">

<h2 id="integrations">按使用场景继续</h2>

<div class="workflow-paths">

### 创建自己的流程

编写 JSON 模板，声明输入和依赖，再发布可重复调用的修订。[创作与发布](/guide/authoring)

### 让 Agent 调用流程

在 Codex 中通过 Skill 使用本地命令，或为支持 MCP 的 Agent 启动 Gateway。[Codex、Skill 与 MCP](/guide/codex)

### 集成到现有应用

选择 TypeScript SDK 或 DeepSeek Harness 插件，把现有工具接入工作流。[接入方式](/guide/) · [DSH / Canvas](/guide/dsh)

</div>

</section>

</div>
