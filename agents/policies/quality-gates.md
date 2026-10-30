# 质量门禁

- 本地必须通过 `pnpm check`、`cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace` 和 `git diff --check`。
- 独立 Reviewer 最终输出 `SOXU_REVIEW_RESULT:{"approved":true,"summary":"..."}`；缺失或不可解析则拒绝。
- Runner 拒绝治理文件、超大变更及密钥文件，严格限制补救重试次数。
- GitHub PR 必过 CI；自动合并在 branch protection / ruleset 有效时才开启。
- 发布必须由 main 上的版本 Tag 触发；CI 检查、签名证书和 Release token 的权限需各自审核。
- 核心质量指标：会话恢复、并发正确性、完整进程树内存、超长 JSONL、崩溃清理。

- 新产品 MVP 依据 `docs/product/prd.md` 中 P-01～P-08 验收；所有“通过”必须提供命令、环境与证据。
- User-facing 文档变更同时更新中文与英文 README；产品 UI 未经审批不得写进正式布局。
- 模型选择严格遵循 `agents/policies/model-selection.md`，日志仅记录公开的 Provider/Model ID 而非认证凭据。
