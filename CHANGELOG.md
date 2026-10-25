# 更新记录

## 0.1.0（已发布，2026-10-25）

- 提供 `huspx-agent-plugins` marketplace 与自包含 MIT 插件 `omp-magpie`。
- 集成 OMP 原生 Magpie 用量，展示账号窗口、余额、重置时间和 gateway key 预算，支持本机、远程及代理路径前缀。
- 支持原生 API-key 登录的统一隐藏输入，接受字面值、环境变量名和 `!command`，以及已有 provider 的 TUI 配置与 CLI 列表、预览、确认保存。
- 支持显式创建缺失 provider、三种聊天协议、Magpie 模型与价卡转换；已有 provider 的地址、认证和最终模型元数据由 OMP 管理。
- 按网关、provider、key 隔离用量与价卡，支持多会话 owner 共享、凭据调和和取消。
- 最低支持 OMP 18.4.1；开发 SDK 与运行验收版本为 18.12.6。
