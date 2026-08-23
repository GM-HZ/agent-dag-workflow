---
name: workflow-builder
description: Plan, create, validate, review, publish, and test DSH DAG workflows through guarded workflow tools. Use for requests to build or modify reusable workflows, DAG automations, workflow templates, human approval flows, subworkflows, or foreach pipelines.
---

# Build DSH workflows

Use only the `workflow_*` tools for catalog mutations and runs. Do not write a template directly to disk or claim a node/tool exists without querying the registry.

1. Clarify the workflow goal, inputs, outputs, external side effects, required human decisions, and reuse boundaries. Ask only when an ambiguity changes behavior or authority.
2. Call `workflow_nodes_list`. Select exact `type@version` entries from its result and obey their config/input/output schemas.
3. Draft a topology plan first: stable kebab-case template id, stable node ids, node purposes, edges, branch ports, and explicit start/end nodes. Keep ordinary edges acyclic; express iteration only with `core.foreach@1`.
4. Build the complete `dsh.workflow/v1alpha1` JSON template. Use structured bindings (`literal`, `input`, `output`, `secret`) and fixed published revisions for subworkflow/foreach targets. Never invent secret values.
5. Call `workflow_draft_create`, or read an existing draft before updating it. Preserve the latest CAS revision and pass it to every update.
6. Call `workflow_validate`. Fix only deterministic structural issues automatically. For unknown providers, ambiguous bindings, changed side effects, approval placement, or retry decisions, ask the user.
7. Repeat update and validation until no error diagnostics remain. Call `workflow_diff` and summarize semantic, node, edge, and layout changes.
8. Publish only when the user already requested publication or confirms after seeing the diff. Call `workflow_publish` with the exact current draft revision; never retry a CAS conflict without reading and reviewing the newer draft.
9. When requested, call `workflow_run` with an exact published id/revision. Use inline templates only for an explicitly described draft test. Report the run id and paused/needs-attention state without treating it as success.

Keep Canvas and generated content as projections of the same template. Do not create a second DSL or encode runtime behavior in layout fields.
