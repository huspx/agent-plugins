# 开发约定

## 文档职责

- 根 `README.md` 面向插件使用者：插件列表、公开 marketplace 安装和更新入口。
- `plugins/<插件名>/README.md` 是可独立阅读的使用指南：兼容版本、安装、配置、常见问题和用户需要知道的限制。
- 本文件面向维护代码的 agent，记录仓库约定和验证方法。README 不放本机绝对路径、临时测试计数、实施进度或内部调研过程。
- 文档只引用纳入版本控制且随仓库分发的资料；本地未跟踪或被忽略的文件不作为文档依据或必需上下文。

## 仓库与分发

- `.omp-plugin/marketplace.json` 定义 marketplace；插件放在 `plugins/<插件名>/`，每个插件自包含。
- 生产源码和运行所需文件只放在插件根内，不从仓库根或兄弟目录导入代码，不携带开发 `node_modules` 或跨目录 symlink。
- 根 package 只承载开发工具、测试和验收脚本，不声明扩展入口，不新增无关的 workspace 或共享运行时包。
- 修改插件版本时，同步修改 marketplace entry 和插件 `package.json`，并更新对应 CHANGELOG。
- 发布 tag 使用 `<插件名>/<版本号>`，例如 `omp-magpie/0.1.1`，版本号不加 `v` 前缀。
- 开发分支按用途命名：`release/<插件名>/<版本号>`、`feat/<插件名>/<功能>`、`fix/<插件名>/<问题>`；例如 `release/omp-magpie/0.1.2`、`feat/omp-magpie/usage`、`fix/omp-magpie/usage-cache`。分支不得与发布 tag 同名。
- 不擅自创建远程仓库、提交、推送或发布 tag。

## omp-magpie

- 最低支持标准 OMP 18.4.4，允许后续稳定版本加载；开发 SDK 与 standalone 验收仅使用 18.12.6，不声称其他版本已验证。使用公开 ExtensionAPI 和宿主导出，不修改 OMP 核心或私有字段。
- 生产模块使用宿主能力与 Node/Bun 内置 API；SDK 类型使用 `import type`，不增加 SDK 运行时依赖或自造类型 stub。
- 已有 provider 只附加 usage；只有显式 `createProvider:true` 或用户确认原生登录创建时才创建缺失的 provider，不覆盖已有注册，不自动切模型。
- 保留 gateway 路径前缀、各模型独立 API/URL，以及按 root/provider/key 隔离的用量身份。不同 key 的报告、预算或在途请求不得混用。
- 复用 `gateway.ts` 的 HTTP、超时、取消与诊断处理，复用 `models.ts` 的价卡转换；不增加轮询、额外重试或另一套持久缓存。
- OMP 动态重建调整 cost/limits、并发刷新失败时回填缓存属于上游行为。记录用户可见限制，不增加插件内规避机制，不因最终 cost/limits 差异阻断创建或 usage 附加；继续检查模型存在和 API/URL 正确。
- API key 不写日志、URL query、插件设置或确认摘要；认证的 env/!command/字面值解析及优先级交 OMP。原生登录统一隐藏输入，返回原始 apiKey 配置字符串，由宿主保存并在使用时解析；连接不复制认证引用。普通附加只保存 provider ID，baseUrl 仅作显式创建的启动输入，已有 provider 地址读取 registry；模型元数据由 Magpie 与 OMP 管理。取消不写入，不手改用户认证、模型配置或 lockfile。
- OMP 18.12.6 的 `/reload-plugins` 不重新导入 TS 扩展或触发本插件启停；安装、更新、停用和卸载需完整重启。插件设置在 session start/switch 读取，自身 setup 保存后立即应用；不拦截内置命令或伪造热重载。
- 验证只使用临时 HOME 与合成凭据，不使用个人凭据或修改真实用户配置。

## 开发与验证

开发环境使用支持原生 TypeScript stripping 的 Node.js（当前 Node 26）和 npm。根 `package.json` 与 lockfile 的开发 SDK 固定为 18.12.6；插件为两个 OMP SDK 声明 `>=18.4.4` 的 optional peer，不新增生产 SDK runtime 依赖。插件运行使用 OMP 内嵌 Bun，不要求安装独立 Bun。

```sh
npm install --ignore-scripts
npm run typecheck
npm test
npm run check:package
```

需要验证宿主集成时，指定现有 standalone OMP 的绝对路径：

```sh
OMP_MAGPIE_OMP_BIN=/absolute/path/to/omp npm run smoke
```

- `OMP_MAGPIE_OMP_BIN` 必须是实际 standalone OMP，不使用可能被 npm script 的 `node_modules/.bin/omp` 遮蔽的裸命令。
- 单元测试放在 `tests/omp-magpie/`，验收辅助放在 `scripts/`；不把测试文件或工具放入生产插件目录。
- 价格映射测试验证插件输出；真实 SDK smoke 验证最终协议路由、用量、凭据隔离及安装生命周期，不要求插件修复上游 catalog 规则。
- smoke 使用临时 HOME、空业务目录和本机 fixture。临时升级版本只修改隔离副本；退出时正常 drain 并清理资源。
- 包检查使用 `npm pack --dry-run` 验证发布列表，不产生正式发布产物。npm 包和 marketplace 实际安装副本都应保持自包含。
- UI 变更需实际运行 TUI；只报告实际观察到的界面。PTY 或 RPC 结果不能替代 Tern 原生鼠标集成验收。
- README 中的 GitHub 地址用于公开发布后的安装；不要把本地市场验收表述为已经验证远程 HTTPS 安装。
