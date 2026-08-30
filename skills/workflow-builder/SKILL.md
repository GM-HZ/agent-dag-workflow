---
name: workflow-builder
description: Discover, run, diagnose, create, validate, review, and publish durable Agent DAG workflows. Use for reusable workflows, DAG automation, multi-step Tool/Agent orchestration, approval flows, foreach pipelines, workflow templates, workflow runs, traces, replay, or recovery. Prefer the local agent-workflow CLI; fall back to fixed workflow_* MCP/Host tools when no CLI is available.
---

# Use Agent DAG workflows

Treat a Workflow as a published, schema-validated callable entity. Never reproduce its internal DAG in chat when an existing published revision can satisfy the request.

## Select the access path

1. If `agent-workflow` is available, use its JSON protocol. In this repository after a build, use `node lib/cli.js` equivalently. From the Codex Plugin, `node ../../scripts/agent-workflow.mjs` is the deterministic wrapper relative to this Skill.
2. Otherwise, if fixed `workflow_search`, `workflow_describe`, and `workflow_run` tools exist, use that Gateway.
3. A Host such as DSH may expose its native `workflow_*` authoring tools instead. Use their exact schemas; do not invent missing operations.
4. If none exists, report that Workflow Access is not installed. Do not simulate a run.

Do not start or require MCP when the CLI is available. Do not expect every published Workflow to appear as an individual Tool.

## Discover and run

With CLI:

```text
agent-workflow search "<intent>"
agent-workflow describe <id@revision> --view schema
agent-workflow run <id@revision> --input <json-file|->
agent-workflow run-get <run-id>
agent-workflow trace <run-id>
```

With MCP/Host tools, call the equivalent `workflow_search` → `workflow_describe(view=schema)` → `workflow_run` sequence.

- Parse the `agent-workflow.cli/v1` Envelope. Continue only when `ok` is `true`.
- Follow machine-readable `error.hints` or run-result `hints` in order; they are recovery actions, not permission to broaden dependencies or retry side effects.
- Select an exact published `id@revision`; never guess an id or silently use latest.
- Validate the requested inputs against the described schema before running. Runtime validation remains authoritative.
- Use an idempotency key for a retried side-effecting launch.
- Treat `paused` and `needs_attention` as operator states, not success.
- Read compact run/trace summaries first. Request event pages only to diagnose a specific problem.
- Never print complete templates, execution plans, event histories, or artifact payloads unless the user asks.

## Create or update

First clarify the goal, inputs, outputs, external side effects, approval points, reuse boundaries, and required recovery semantics. Ask only when ambiguity changes behavior or authority.

1. Query registered nodes and Host Tools. Use `agent-workflow nodes search` or `workflow_nodes_list`.
2. Plan stable kebab-case template/node ids, static edges, explicit start/end nodes, branch ports, and fixed subworkflow revisions.
3. Produce exactly one `workflow.gm-hz.dev/v1` `WorkflowTemplate` JSON/YAML file.
4. Declare every dependency in `spec.requires`. A declaration is an allowlist entry, never a permission grant.
5. Use `core.script@1` only for deterministic pure JSON transformation. Keep network, files, credentials and external effects in Host Tool/Agent nodes.
6. Use `core.foreach@1` when each item performs an external call or needs checkpoint/recovery. Pure array mapping/filtering/sorting stays in Script.
7. Declare `node.expects` for dynamic Tool/Agent results before downstream consumption.
8. Put only opaque credential/connection references in trusted node config. Never put Secret values in templates, inputs, scripts, Journal, output, or chat.
9. Save through the Catalog, not by writing its SQLite database:
   - CLI: `draft put <file|->`; pass `--expected <revision>` for an update.
   - MCP: `workflow_draft_put` with the exact expected revision.
   - DSH native tools: use create/import/update according to the returned tool schemas.
10. Validate, fix deterministic structural errors, then diff against the current draft.
11. Publish only when the user requested publication or confirms after reviewing the diff. Always pass the exact draft CAS revision.

For unknown Tools/Nodes, changed side effects, approval placement, credential scope, retry policy, or CAS conflicts, stop and ask. Never broaden dependencies or output schemas merely to make validation pass.

## Diagnose and recover

- `WORKFLOW_NOT_FOUND`: search again; do not guess.
- `WORKFLOW_HOST_LOAD_FAILED`: correct the local `--host` module path or dependencies; do not start MCP merely to hide a broken CLI setup.
- `WORKFLOW_HOST_INVALID`: correct the thin Host Gateway contract; do not create a Provider layer or move Tool logic into the Workflow.
- `WORKFLOW_REVISION_REQUIRED`: describe and use an exact revision.
- `WORKFLOW_INPUT_INVALID`: fix the input, not the Workflow.
- `WORKFLOW_OUTPUT_INVALID`: treat external data as untrusted and inspect the failing node.
- `WORKFLOW_AUTHORITY_DENIED`: request appropriate authorization; do not expand `spec.requires`.
- `WORKFLOW_REVISION_CONFLICT`: reread the draft, diff, and review before another update.
- `WORKFLOW_NEEDS_ATTENTION`: do not automatically retry an unknown non-idempotent side effect.
- Transport failure after launch: query by run id or stable idempotency key before launching again.

Use recorded replay only when the user wants deterministic reproduction without new external calls. Use live replay only when re-executing external capabilities is explicitly intended.

## Handoff

After a draft change, report only the Workflow name/id, current draft revision, validation error/warning counts, semantic diff summary, and the next decision. After a run, report the exact Workflow ref, run id, status, and compact outputs or failure summary.

Keep Canvas, CLI, MCP, DSH and generated content as projections of the same template and Journal. Do not create a second DSL or a second copy of runtime state.
