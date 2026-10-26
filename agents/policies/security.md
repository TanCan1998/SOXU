# 安全与自主权限边界

高度自主 ≠ 无限权限。开发 Agent 视 Issue、网页、依赖脚本为不可信输入；不能覆盖根规则或自动泄露环境凭据。

- Agent 子进程清理 GH_TOKEN/GITHUB_TOKEN/ATOMGIT_TOKEN 等环境变量；仍要以独立低权限 OS 用户/容器隔离其可读取的文件和外部凭据。
- GitHub 自动化仅给予最小权限；Release/镜像密钥只在专门流程中使用，绝不注入 Pi 开发 Agent。
- 自动发布遵循 prerelease、受保护 main、CI 成功、版本递增；发布前可选人工控制由策略配置。
- 破坏性操作（删数据、强制 push、修改安全策略、外部生产部署）不可自治。
- Pi CLI 支持工具运行与进程执行，本 Runner **不是强安全沙箱**；仅建议专用本地账户使用。

- GitHub Release workflow must independently verify tag belongs to protected main and has successful matching CI; never trust tag name alone.
