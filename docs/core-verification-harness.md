# Core Verification Harness

The verification harness protects the small, Agent-native Workflow Core. It is test infrastructure, not a scheduler, Worker framework, or production dependency.

## Scope

The harness verifies two load-bearing properties:

1. Generated conditional DAGs that compile can execute without missing branch data and always reach one durable terminal result.
2. A process failure before any atomic RunStore commit leaves a checkpoint that can be inspected and resumed without silently accepting an external side effect.

Queue leasing, Worker heartbeats, distributed scheduling, throughput benchmarks, and UI behavior are explicitly outside this harness. Those are optional Host concerns and must not increase the default Core mental model.

## Deterministic DAG generation

`dag-properties.spec.ts` uses a small seeded PRNG with no runtime dependency. A seed generates nested condition diamonds, unequal branch lengths, transitive reconvergence, and unconditional parallel nodes. Every failure reports its seed.

For every generated case the harness checks:

- the safe graph compiles;
- replacing a guaranteed binding with branch-local data is rejected;
- execution selects only the expected branch;
- skipped branch nodes cannot leak data;
- the End node and unconditional producers execute;
- Event sequences and the terminal Checkpoint are contiguous and consistent.

The normal suite runs a small deterministic sample. Increase coverage locally without changing code:

```bash
WORKFLOW_VERIFY_CASES=10000 WORKFLOW_VERIFY_SEED=20260829 pnpm verify:core
```

## Commit failpoint matrix

`commit-failpoints.spec.ts` first records every atomic commit batch of a representative external Tool Workflow. It then reruns the Workflow once per commit boundary and throws immediately before that batch reaches the underlying Store.

After every simulated crash the harness checks:

- the durable Checkpoint sequence still equals the last Journal sequence;
- no partial event batch is visible;
- recovery either completes automatically or explicitly pauses an unknown external node;
- an external result whose completion commit was lost is never assumed successful;
- an operator-authorized retry can complete the Run.

This deliberately models only failure *before* the Store transaction. A real Store implementation remains responsible for making `commit(checkpoint, events)` atomic.

## Commands

```bash
pnpm check
pnpm verify:core
```

`pnpm check` includes a fast verification sample. `pnpm verify:core` is the focused command for larger seeded runs and failure reproduction.
