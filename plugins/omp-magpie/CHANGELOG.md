# 更新记录

## 0.1.2（2026-10-28）

- 新建 provider 为 OpenAI Responses 和 Completions 模型逐模型声明 strict 字段支持，使 task 的 `strict: false` 可显式传递；已有 provider 仍只附加 usage，不修改模型配置。
- 补充普通 task 参数错误的排查及已有 provider 的兼容配置说明；使用前需确认路由接受 strict，更新后完整重启 OMP。

## 0.1.1（已发布，2026-10-26）

- 面板内插件生成的标签、周期和诊断统一使用英文；服务端名称与说明保留原文，更新 usage 缓存版本以重新采集。
- 修复身份探测失败时共享绑定遗漏新 owner 租约的问题，原 owner 退出后保留兼容 owner 的 adapter 与在途读取。
- 在账号额度、余额和 Key 多周期预算之外，展示按账号归属的重置券库存；通用次数与窗口／团队库存分开，合法零值、未知到期和错误／延迟诊断保持明确，兑换操作由 Magpie 管理。
- 额度保留真实零值、供应商比例与超额；文本窗口优先展示说明，缺失 amount 不伪造已用量。账号／窗口标签保留必要归属，数值、缓存口径、预留与未定价说明可对应具体额度。
- 最低 OMP 版本提升为 18.4.4；支持 Tern Native Details，保留宿主 ANSI 回退和 RPC 文本入口。开发 SDK 与运行验收版本仍为 18.12.6，安装或更新后需完整重启。

## 0.1.0（已发布，2026-10-25）

- 在 OMP 原生 `/usage` 中展示 Magpie 账号窗口、余额、重置时间与当前 gateway key 的 token、金额预算，保留权限与部分读取失败诊断。
- 支持本机无鉴权、远程 API-key 和代理路径前缀，自动识别合格 provider，并支持仅声明 `providerId` 的显式附加。
- 提供原生 `/login magpie`、`omp login magpie`，统一隐藏输入 `apiKey`，支持字面值、环境变量名和 `!command`，由宿主保存并解析原生认证。
- 提供已有 provider 的 `/magpie setup` TUI 确认及 CLI 候选列表、只读预览、`--yes` 核验保存。
- 支持 `createProvider:true` 与 `baseUrl` 显式创建缺失 provider，读取 Magpie 聊天目录，映射 Anthropic Messages、OpenAI Responses、OpenAI Completions 及模型价卡。
- 按网关、provider、key 隔离用量、在途读取和保留价卡；支持凭据轮换、owner 共享及取消，阻止冲突身份混用。
- 提供自包含 MIT 包；最低支持 OMP 18.4.1，开发 SDK 与运行验收版本为 18.12.6。最终模型成本、上限及刷新缓存行为遵循宿主规则。
