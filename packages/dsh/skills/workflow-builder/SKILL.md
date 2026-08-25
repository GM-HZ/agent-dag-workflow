---
name: workflow-builder
description: Plan, create, validate, review, publish, and test DSH DAG workflows through guarded workflow tools. Use for requests to build or modify reusable workflows, DAG automations, workflow templates, human approval flows, subworkflows, or foreach pipelines.
---

# Build DSH workflows

Use only the `workflow_*` tools for catalog mutations and runs. Do not write a template directly to disk or claim a node/tool exists without querying the registry.

1. Clarify the workflow goal, inputs, outputs, external side effects, required human decisions, and reuse boundaries. Ask only when an ambiguity changes behavior or authority.
2. Call `workflow_nodes_list`. Apply the two-level extension rule: select a returned DSH `tool` and use `dsh.tool@1` for every ordinary external call; select an exact custom `type@version` Node only when the workflow needs lifecycle semantics that a Tool cannot express. Choose `dsh.agent@1` providers only from `agentProviders`, and restrict `with.outputSchema` to that provider's advertised structured-output dialect. Obey all config/input/output schemas. Inspect `scriptRuntimes` before choosing `core.script@1`; never invent a Tool, provider, Node, or language id.
3. Draft a topology plan first: stable kebab-case template id, stable node ids, node purposes, edges, branch ports, and explicit start/end nodes. Keep ordinary edges acyclic; express iteration only with `core.foreach@1`.
4. Build the complete `dsh.workflow/v1alpha1` JSON template. Use structured bindings (`literal`, `input`, `output`, `secret`) and fixed published revisions for subworkflow/foreach targets. Never invent secret values.
   - Build `spec.requires` from every selected node's `capabilities/defaultRequirements`, fixed config-derived Tool/Agent provider/Runtime/subworkflow, and every secret reference. A requirement is an allowlist entry, not permission. Never omit it to make validation pass and never add broad unused capabilities.
   - Declare `node.expects.schema` and a reasonable `maxBytes` for dynamic Tool/Agent results before consuming them. The schema covers the complete node output object (for a Tool, usually `{ result: ... }`).
   - Use `core.script@1` for deterministic JSON shaping, field mapping, text formatting, filtering, projection, and aggregation when a listed runtime supports it.
   - The built-in `dsh.expr@1` reads only `input`, must return one object, and has no I/O. Keep external calls in `dsh.tool@1`, model reasoning in `dsh.agent@1`, and human decisions in `dsh.human-approval@1`.
   - Treat script source as fixed workflow logic, not a place for user-provided executable code or credentials. Set an explicit bounded `maxOperations` for non-trivial expressions.
5. Call `workflow_draft_create`, or read an existing draft before updating it. For a large template, pass its complete lossless JSON text to `workflow_draft_import` instead of stringifying an object into the `template` field. Preserve the latest CAS revision and pass it to every update/import.
6. Call `workflow_validate`, or `workflow_draft_validate` after an import. Fix only deterministic structural issues automatically. For unknown Tools/Nodes/providers, ambiguous bindings, changed side effects, approval placement, or retry decisions, ask the user.
   Treat `WORKFLOW_REQUIREMENT_UNDECLARED` as a request to review and explicitly add the exact dependency, never as permission to replace it with a broader wildcard. Treat output expectation failures as untrusted/invalid data; do not silently loosen the schema.
7. Repeat update and validation until no error diagnostics remain. Call `workflow_diff` and summarize semantic, node, edge, and layout changes.
8. Publish only when the user already requested publication or confirms after seeing the diff. Call `workflow_publish` with the exact current draft revision; never retry a CAS conflict without reading and reviewing the newer draft.
9. When requested, call `workflow_run` with an exact published id/revision. Use inline templates only for an explicitly described draft test. Report the run id and paused/needs-attention state without treating it as success.

Keep Canvas and generated content as projections of the same template. Do not create a second DSL or encode runtime behavior in layout fields.
