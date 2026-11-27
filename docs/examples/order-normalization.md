# 从订单失败到候选回归

这个例子把订单汇总为总金额、获批订单 ID 和获批订单平均金额。基线遇到零笔获批订单时会在 `normalize` 节点除以零。候选版本在这种情况下返回 `approvedAverage: null`。有获批订单的结果应保持一致。两个模板都只使用纯 JSON 变换。

从仓库根目录执行。源码检出后可用 `pnpm build` 构建，再用 `node lib/cli.js` 代替下面的 `adw`。使用一个新目录保存 SQLite、日志、样本和报告。

```bash
run_dir=$(mktemp -d)
db="$run_dir/orders.db"
example=examples/order-normalization
mkdir "$run_dir/cases"

adw validate "$example/baseline.workflow.json" --input "$example/inputs-no-approved.json" --strict --db "$db"
adw draft put "$example/baseline.workflow.json" --db "$db"
adw publish personal-order-normalization --expected 1 --db "$db"
adw run personal-order-normalization@1 --input "$example/inputs-no-approved.json" --db "$db"
```

最后一条命令会返回持久化的 Run ID 和 `failed` 状态。输入通过了 Schema 校验，失败发生在运行中的 `normalize` 节点。将 `FAILED_RUN_ID` 替换为实际值。

```bash
adw trace FAILED_RUN_ID --all --output "$run_dir/failed.jsonl" --db "$db"
adw verify-log "$run_dir/failed.jsonl"
adw case from-run FAILED_RUN_ID --output "$run_dir/cases/no-approved.json" --db "$db"

adw run personal-order-normalization@1 --input "$example/inputs-approved.json" --db "$db"
adw case from-run COMPLETED_RUN_ID --output "$run_dir/cases/approved.json" --db "$db"
```

打开 `no-approved.json`，将原有 `expected` 完整复制到同级 `baselineExpected`。原有 `expected` 改为以下内容，表示候选应修复这个失败。正常订单的 `approved.json` 使用原样本。

```json
{
  "status": "completed",
  "requiredNodes": ["start", "normalize", "end"],
  "outputs": {
    "customer": "ACME",
    "orderCount": 2,
    "total": 30,
    "approvedIds": [],
    "summary": "acme / 2 orders",
    "approvedAverage": null
  }
}
```

```bash
adw case compare "$run_dir/cases" \
  --base personal-order-normalization@1 \
  --candidate "$example/candidate.workflow.json" \
  --output "$run_dir/report.json" --db "$db"
```

报告中，零笔获批订单应为 `expected-correction`，正常订单应为 `passed`，其平均获批金额为 `44.25`。运行比较会生成本地报告，候选文件仍可继续修改后复测。

在 DSH 的 Workflow Canvas 也可以导入相同基线 JSON，保存并发布，在已发布修订面板填入同一份输入。从运行历史查看失败节点、下载 JSONL 和保存回归用例。Codex 可用 `workflow-builder` Skill，通过同一 CLI 契约完成上述步骤。
