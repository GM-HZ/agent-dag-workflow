# Agent DAG Workflow

[简体中文](README.md) · English

Agent DAG Workflow is a host-neutral runtime for defining, running, and recovering directed acyclic graph (DAG) workflows. A single `WorkflowTemplate` can run through the CLI, Codex Skill, MCP gateway, DeepSeek Harness (DSH), or TypeScript SDK. Your host supplies tools, agents, and permissions. The runtime validates the graph, executes its nodes, and records the run for inspection, recovery, and replay.

[Documentation](https://gm-hz.github.io/agent-dag-workflow/) · [Runnable examples](examples/README.md) · [WorkflowTemplate v1 specification](spec/workflow-template-v1.md)

## Quick start

Requires Node.js 22.19 or later. Create a directory and install the package:

```bash
mkdir adw-quickstart
cd adw-quickstart
npm install @gm-hz/agent-dag-workflow
```

The package includes a workflow that processes three sample orders. Validate the template, save a draft, publish it, and run revision 1. This example needs no model account or external tools.

```bash
adw_examples=node_modules/@gm-hz/agent-dag-workflow/examples

npm exec -- adw validate "$adw_examples/script-transform.workflow.json"
npm exec -- adw draft put "$adw_examples/script-transform.workflow.json"
npm exec -- adw publish script-transform-demo --expected 1
npm exec -- adw run script-transform-demo@1 --input "$adw_examples/inputs/script-transform.json"
```

Look for `data.status` set to `completed` and a `data.outputs` object containing:

```json
{
  "customer": "GM-HZ",
  "orderCount": 3,
  "total": 100,
  "approvedIds": ["A-100", "A-102"]
}
```

In the same directory, replace `RUN_ID` with `data.runId` from the run output to inspect its recorded events:

```bash
npm exec -- adw trace RUN_ID --events
```

The CLI stores drafts, published workflows, and run history in `.agent-dag-workflow.db` in the current directory. To use a different SQLite file, pass the same `--db` path to each command that reads or writes workflow data. The package exposes both `adw` and `agent-workflow` as names for the same CLI.

## Build your own workflow

Start with the [sample template](examples/script-transform.workflow.json) and the [authoring guide](docs/guide/authoring.md). A template declares its input and output schemas, nodes, edges, and required capabilities. Use a script node for JSON transformations, a condition node to select a branch, or a foreach node to call a tool or agent for each item.

Validate and save your template as a draft. Publish it using the revision returned by the draft command, then run the published workflow by its explicit `id@revision`. The published revision is immutable. Hosts that supply external tools or agents configure a [Host Adapter](docs/host-adapter.md) to resolve capabilities and apply their own permission and credential policies.

Use a run's trace to inspect node and output events in sequence. Recorded replay starts a new run from a completed run, reuses committed external results, and recalculates deterministic steps. Live replay calls the external capabilities again.

## Choose an integration

| If you use | Start here |
| --- | --- |
| A terminal or CI | Use the `adw` CLI to validate, publish, run, and trace a workflow. |
| Codex | Install the [Codex plugin and on-demand Skill](docs/guide/codex.md#codex-plugin) to discover and run workflows through the CLI. |
| An MCP client | Connect the [fixed MCP gateway](docs/guide/codex.md#mcp-only-agent). The `invoke` profile exposes tools to search, describe, run, and inspect workflows. |
| DeepSeek Harness | Use the [DSH bundle and Canvas](README.md#dsh-与-canvas) to edit workflows and open traces in the Web app. Check [supported DSH versions](package.json) under `engines.dsh`. |
| Your own Node.js application | Import `WorkflowRuntime` from `@gm-hz/agent-dag-workflow` and connect your [host tools and agents](docs/host-adapter.md). |

See the [examples](examples/README.md) for approval gates, parallel calls, and subworkflows. The [operations guide](docs/operations.md) covers SQLite storage, recovery, and delivery.

## License

[MIT](LICENSE)
