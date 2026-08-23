# Reference projects

以下版本是本轮架构设计的源码基线。

| Project | Revision | Checkout | License note |
|---|---|---|---|
| DeepSeek Harness | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | 完整历史、partial blob clone，`master` | MIT |
| Coze Studio | `fefb05ff27be1da939612fbf9faf5db62583b8ae` | shallow partial clone，稀疏检出 workflow/Canvas 相关目录 | Apache-2.0 |
| Dify | `8bdf702f737e31bc1f9e75def597e639f9b01f8c` | shallow partial clone，稀疏检出 workflow/Canvas 相关目录 | Modified Apache-2.0；直接复用代码前必须复核附加条件 |
| Graphon | tag `v0.7.0`, `11e2dee8cbd6dc2e6bf1c2059d9bbf4d0437ebe5` | shallow clone | Apache-2.0；Dify 当前锁定的图执行内核 |

DSH 不是 shallow clone；`--filter=blob:none` 只避免预取未访问的历史 blob，提交历史完整。Coze Studio 与 Dify 的工作树是 sparse checkout，需要查看其他目录时可执行：

```bash
git -C ref_project/coze-studio sparse-checkout add <path>
git -C ref_project/dify sparse-checkout add <path>
```

重新建立相同基线的核心命令：

```bash
git clone --filter=blob:none https://github.com/deepseek-ai/deepseek-harness.git ref_project/deepseek-harness
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/coze-dev/coze-studio.git ref_project/coze-studio
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/langgenius/dify.git ref_project/dify
git clone --depth 1 https://github.com/langgenius/graphon.git ref_project/graphon
```

Graphon 随后检出 Dify 锁定版本：

```bash
git -C ref_project/graphon fetch --depth 1 origin tag v0.7.0
git -C ref_project/graphon checkout --detach v0.7.0
```
