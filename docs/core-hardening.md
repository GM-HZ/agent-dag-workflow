# Core hardening design

This document defines the load-bearing invariants of the Agent DAG Workflow Core. Adapters may add transport, UI, scheduling, or Host integrations, but they must not weaken these invariants.

## 1. Host-owned resource ceilings

`WorkflowDeploymentLimits` belongs to the deployment, not to template authors. A template policy is a request to **reduce** a limit. It is never an authority grant.

The default ceilings are intentionally separate from the normal execution defaults:

| Limit | Normal default | Deployment ceiling |
| --- | ---: | ---: |
| Concurrent nodes | 4 | 16 |
| Node runs | 100 | 1,000 |
| Duration | 10 minutes | 60 minutes |
| Output bytes | 1 MiB | 8 MiB |
| Retained Checkpoint bytes | — | 12 MiB |
| Subworkflow depth | 8 | 16 |

The compiler and Catalog publication reject authored values above the configured ceiling. The Engine computes `min(authored/default, deployment)` again at execution and recovery time. This second check protects inline runs, persisted runs, and deployments whose policy became stricter after publication.

`maxCheckpointBytes` is Host-only because it limits cumulative retained state rather than one template operation. Core checks the initial graph state, progress, committed node outputs, and the assembled terminal result before capture/commit. A rejected addition is rolled back and becomes a durable failure without entering the Checkpoint. Recovery after a deployment limit reduction uses the existing Checkpoint, worst-case ready-queue size, and a small fixed recovery-metadata reserve as its floor, so an older Run is not made administratively unrecoverable.

## 2. Path-safe data bindings

Topological ancestry is insufficient in a conditional DAG: an ancestor may be skipped on the path that activates a downstream join.

Core therefore enforces two related rules:

1. An output producer must either dominate its consumer or itself be globally guaranteed. This accepts both conditional data that is present on every path to the consumer and unconditional parallel fan-out whose producers always execute.
2. A Workflow output must reference an End node proven to execute on every successful path.

For multi-port nodes, Core proves guarantee transitively: every declared output port must have an activated successor from which the target is itself inevitable. This recognizes ordinary branch/reconvergence graphs without special edges. Branch-local data cannot cross an OR-join unless a future explicit merge primitive defines how absent values are normalized. This conservative rule favors a rejected draft over a published Workflow that can only fail at runtime.

## 3. External result commit protocol

An external invocation follows this order:

1. Persist `capability.requested` while the node is `running`.
2. Invoke the Host Gateway with the stable `invocationId` and current Authority.
3. Snapshot lossless JSON.
4. Validate NodeDefinition output schema.
5. Validate instance `expects` schema.
6. Validate selected ports and byte limits.
7. Verify that the cumulative Checkpoint remains inside the Host budget.
8. Capture validated capability/node output according to deployment policy.
9. Atomically commit `capability.completed`, `node.output-validated`, `node.output-committed`, `node.completed`, outgoing edges, and the checkpoint containing the output.

If steps 2-8 fail, Core commits `capability.failed` and then a durable node/run failure. Invalid or oversized dynamic data never receives a completed event and never enters Artifact capture. A process crash after the external side effect but before the atomic completion commit leaves the node `running`; retry-never nodes consequently require an explicit operator decision.

Recorded replay uses the same schema, expectation, port, and size gates before atomically committing `capability.replayed` with the restored node output.

## 4. Durable terminal states

Business and policy failures must be reflected by both the returned result and the persisted checkpoint. Output binding errors, final output schema errors, and final output size errors use the same `finishFailure` transition as node failures.

Storage commit failures are different: they represent an unknown persistence boundary. Core returns a failed local observation but deliberately leaves the last durable checkpoint recoverable. `WorkflowCommitFailure` is the explicit internal discriminator between these cases.

## 5. Durable cancellation

An active handle obtained from a persisted idempotent run must not acknowledge a no-op cancellation. Core reloads the latest record and commits a CAS-protected terminal cancellation that:

- marks unresolved, waiting, and attention nodes cancelled;
- clears the ready queue;
- appends node cancellation events and `run.cancelled`;
- prevents late worker output from overwriting the terminal checkpoint.

Cancellation remains cooperative for code already executing outside the process. Host Gateways must observe `AbortSignal` and make stable `invocationId` idempotent; Core guarantees that late data cannot become the committed Workflow result after cancellation wins the checkpoint race.

## 6. Verification gates

Every Core change must retain tests for:

- policy ceiling rejection at compile and publication;
- branch-local binding and non-guaranteed End rejection;
- invalid external output never being captured or marked completed;
- terminal assembly failures becoming durable failures;
- persisted idempotent handle cancellation;
- crash recovery at commit boundaries and RunStore CAS conflict rejection.

The generated DAG/path tests and systematic commit failpoint matrix are defined in [Core Verification Harness](core-verification-harness.md). Distributed Worker/lease testing is intentionally not part of Core: it belongs to an optional Host runner if deployment needs it. Retries and compensation are separate features and must not be added by weakening the unknown-side-effect recovery rules.
