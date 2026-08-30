# 1.0 发布流程

## 自动门禁

`v*` tag 触发 `.github/workflows/release.yml`。流水线校验 tag 与 `package.json` 版本完全一致，运行全量测试、真实网络 tarball 安装、生产依赖审计，再通过 npm OIDC 发布。Release job 固定使用支持 trusted publishing 的 npm 11.7.0，并申请最小 `contents: read` / `id-token: write` 权限。

## 首次发布的 bootstrap

`@gm-hz/agent-dag-workflow` 首次发布前在 npm registry 中还不存在，因此没有 package settings 页面可配置 Trusted Publisher。第一次需要由 `@gm-hz` organization 的 Maintainer 在本机完成：

```bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
pnpm check
AGENT_DAG_VERIFY_NETWORK_INSTALL=1 pnpm verify:pack
npm publish --access public --registry=https://registry.npmjs.org
```

首次发布完成后，立即在 npm package Settings → Trusted publishing 配置：

- GitHub owner：`GM-HZ`
- Repository：`agent-dag-workflow`
- Workflow filename：`release.yml`
- Environment：`npm`
- Allowed action：`npm publish`

随后把 Publishing access 改为要求 2FA 并禁止传统 token。后续版本只通过受保护 tag 和 GitHub Environment 审批发布。

## 1.0 顺序

首次 1.0 不要在 bootstrap 之前先推 `v1.0.0` tag，否则自动发布尚未建立信任关系。推荐顺序：合并并推送版本提交 → 本机通过 2FA 首发 1.0.0 → 配置 Trusted Publisher → 创建并推送 `v1.0.0` tag。该 tag 的流水线会再次运行全部门禁，并在确认相同 immutable version 已存在后跳过重复 publish。后续 tag 则完全自动发布。

发布后确认：

```bash
npm view @gm-hz/agent-dag-workflow version dist-tags --registry=https://registry.npmjs.org
npm install @gm-hz/agent-dag-workflow
```
