# @gm-hz/dsh-dag-workflow

Installable DeepSeek Harness bundle for durable DAG workflows, Agent authoring tools, SQLite persistence, and Canvas Studio.

```bash
dsh plugin --profile web add @gm-hz/dsh-dag-workflow
```

The bundle patch mounts the durable runtime and `@gm-hz/dsh-dag-workflow-canvas`. Its default SQLite database is stored at `dshHomePath('dsh-dag-workflow/workflows.db')`. When upgrading from 0.1.4 or earlier, the bundle safely copies a legacy `dsh-workflow/workflows.db` with SQLite's backup API before opening the new path and retains the legacy file as a backup.

The Canvas Remote accepts only live, top-level Agents from the Host registry. Its zero-config policy is intended for a local single-user profile; multi-user deployments must configure the Canvas plugin's user/workspace/action `authorize` policy directly.

See the [repository README](https://github.com/GM-HZ/dsh-dag-workflow#readme) for the template format, authoring flow, execution API, security boundary, and custom node SDK.
