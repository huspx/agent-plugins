# 更新记录

## 0.1.0（已发布，2026-10-25）

- 在 OMP 原生 `/usage` 中展示 Magpie 账号窗口、余额、重置时间与当前 gateway key 的 token、金额预算，保留权限与部分读取失败诊断。
- 支持本机无鉴权、远程 API-key 和代理路径前缀，自动识别合格 provider，并支持仅声明 `providerId` 的显式附加。
- 提供原生 `/login magpie`、`omp login magpie`，统一隐藏输入 `apiKey`，支持字面值、环境变量名和 `!command`，由宿主保存并解析原生认证。
- 提供已有 provider 的 `/magpie setup` TUI 确认及 CLI 候选列表、只读预览、`--yes` 核验保存。
- 支持 `createProvider:true` 与 `baseUrl` 显式创建缺失 provider，读取 Magpie 聊天目录，映射 Anthropic Messages、OpenAI Responses、OpenAI Completions 及模型价卡。
- 按网关、provider、key 隔离用量、在途读取和保留价卡；支持凭据轮换、owner 共享及取消，阻止冲突身份混用。
- 提供自包含 MIT 包；最低支持 OMP 18.4.1，开发 SDK 与运行验收版本为 18.12.6。最终模型成本、上限及刷新缓存行为遵循宿主规则。
