# @gm-hz/dsh-workflow

Installable DeepSeek Harness bundle for durable DAG workflows, Agent authoring tools, SQLite persistence, and Canvas Studio.

```bash
dsh plugin --profile web add @gm-hz/dsh-workflow
```

The bundle patch mounts the durable runtime and `@gm-hz/dsh-workflow-canvas`. Its default SQLite database is stored at `dshHomePath('dsh-workflow/workflows.db')`.

The Canvas Remote accepts only live, top-level Agents from the Host registry. Its zero-config policy is intended for a local single-user profile; multi-user deployments must configure the Canvas plugin's user/workspace/action `authorize` policy directly.

See the [repository README](https://github.com/GM-HZ/dsh-workflow#readme) for the template format, authoring flow, execution API, security boundary, and custom node SDK.
