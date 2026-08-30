---
layout: home

hero:
  name: "Agent DAG Workflow"
  text: "让 Agent 生态拥有稳定的流程内核"
  tagline: "一份 JSON，连接 CLI、Skill、MCP、DSH、Trigger 与 Canvas。Host 保留 Tool、Agent 和权限；Runtime 负责 DAG、恢复、Trace 与 Replay。"
  actions:
    - theme: brand
      text: 5 分钟运行成功
      link: /guide/quickstart
    - theme: alt
      text: 查看 9 个可执行案例
      link: /examples/

features:
  - icon: CORE
    title: Runtime-centered
    details: 编译、执行、Journal、Checkpoint 与 Replay 只有一套事实模型。
  - icon: AGENT
    title: CLI-native · Skill-on-demand
    details: 有终端的 Agent 优先使用 CLI；Skill 只在需要时加载，不常驻消耗上下文。
  - icon: HOST
    title: 复用现有 Tool 与 Agent
    details: 不建设 Provider 市场。外部能力继续属于 Host，并经过 requires、Authority 和 Schema。
---

<section class="home-blueprint">
  <div class="blueprint-kicker">One durable path</div>
  <h2>离散能力进入 DAG，动态结果进入审计链。</h2>
  <div class="flow-rail" aria-label="Workflow execution path">
    <div class="flow-stop"><b>01</b><strong>Template</strong><span>固定节点、依赖、输入输出与发布修订</span></div>
    <div class="flow-stop"><b>02</b><strong>Compile</strong><span>拓扑、Binding、Schema 与权限声明 fail closed</span></div>
    <div class="flow-stop"><b>03</b><strong>Host call</strong><span>Tool、Agent、Approval 只从显式 Gateway 调用</span></div>
    <div class="flow-stop"><b>04</b><strong>Validate</strong><span>外部结果通过 lossless JSON、expects 与大小门禁</span></div>
    <div class="flow-stop"><b>05</b><strong>Journal</strong><span>Event 与 Checkpoint 原子提交，可 Trace、恢复和重放</span></div>
  </div>
  <div class="audience-grid">
    <article class="audience-card"><em>调用者</em><h3>运行已有流程</h3><p>只需要搜索、读取 Schema、准备输入和运行固定修订。</p><a href="./guide/quickstart">从一个命令开始 →</a></article>
    <article class="audience-card"><em>Agent</em><h3>通过 Skill 驱动</h3><p>Codex 使用本地 CLI；没有终端时退回固定数量的 MCP Gateway。</p><a href="./guide/codex">选择 Agent 入口 →</a></article>
    <article class="audience-card"><em>集成者</em><h3>接入现有生态</h3><p>实现薄 Host Gateway，不复制模型、凭据、MCP 或 Tool 系统。</p><a href="./host-adapter">查看最小接口 →</a></article>
  </div>
</section>
