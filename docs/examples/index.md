<script setup>
import manifest from '../../examples/manifest.json'
</script>

# 9 个可执行 Examples

这里不是模板陈列柜。每个案例都绑定输入、期望输出、确定性 Host 和固定发布修订，并在 CI 中通过 Codex Plugin wrapper 完整执行。

```bash
pnpm examples:codex
```

<div class="example-grid">
  <article v-for="example in manifest.examples" :key="example.id" class="example-entry">
    <header><h3>{{ example.title }}</h3><code>{{ example.id }}@{{ example.revision }}</code></header>
    <p>{{ example.level }} · {{ example.workflow }}</p>
    <div class="example-tags"><span v-for="capability in example.capabilities" :key="capability">{{ capability }}</span></div>
  </article>
</div>

## 回归到底验证什么

每个案例必须同时满足：

1. 当前 `workflow.gm-hz.dev/v1` Parser 接受；
2. Compiler 没有诊断错误；
3. Draft 能保存并发布到清单声明的修订；
4. Codex wrapper 能搜索并读取输入输出 Schema；
5. 确定性 Host 能完成真实 Runtime 执行；
6. 输出包含清单绑定的期望结果；
7. `run-get` 和 Journal Trace 能跨 CLI 进程读取终态。

清单位于 [`examples/manifest.json`](https://github.com/GM-HZ/agent-dag-workflow/blob/main/examples/manifest.json)。复杂案例的业务说明见 [Showcase Workflows](../showcase-workflows)。
