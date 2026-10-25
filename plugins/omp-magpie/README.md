# omp-magpie

在 OMP 的原生 `/usage` 面板中查看 [Magpie](https://github.com/yetone/magpie) 的账号窗口、余额、重置时间，以及当前 gateway key 的 token 和金额预算。支持本机网关、远程网关和代理路径前缀；可附加已有 provider，也可显式创建 provider 并读取 Magpie 聊天模型及价卡。

## 使用条件

- **OMP >=18.4.1 的稳定版本**。运行验收仅使用 **18.12.6**；允许后续版本加载不等于已验证其兼容性。
- Magpie 已运行，且网关地址可访问。
- OMP 使用 gateway API key 或本机无鉴权方式连接 Magpie。请使用独立 provider；带 OAuth、原生 ranking 或其他用量插件的 provider 不符合附加条件。

这些认证要求针对 OMP 到 Magpie 的连接。Magpie 内部仍可使用其支持的订阅账号。插件为自包含安装包，无需额外安装 Node.js、npm 或 Bun。

## 安装与查看用量

```sh
omp plugin marketplace add https://github.com/huspx/agent-plugins.git
omp plugin install omp-magpie@huspx-agent-plugins --scope user
```

重启 OMP，选择 Magpie provider 下的模型，再输入：

```text
/usage
```

已有名为 `magpie` 的合格 provider 通常无需额外设置。其他已有 provider 可使用下面的配置向导。原生成本区域的交互由 OMP 和终端提供，用量查询可直接使用 `/usage`。

## 原生登录与创建 provider

在交互会话中输入 `/login magpie`，或在 shell 中运行：

```sh
omp login magpie
```

按提示输入网关地址和 `apiKey`，检查确认摘要后输入 `yes`。同一个隐藏输入框接受字面值、环境变量名或以 `!` 开头的命令，解析规则与 OMP 的 `apiKey` 一致。例如，先设置环境变量：

```sh
export MAGPIE_GATEWAY_KEY='替换为你的 gateway key'
omp login magpie
```

在 `apiKey` 提示框中输入 `MAGPIE_GATEWAY_KEY`。OMP 原生认证保存输入配置，使用时解析；插件以解析后的 key 核验网关，认证不进入插件设置或确认摘要。环境变量从 OMP 进程当前环境读取，`!command` 的执行与缓存遵循宿主规则。取消或网关校验失败时不保存连接和认证。

TUI 登录成功后，通过 `/model` 选择模型，插件不会自动切换当前模型。CLI 登录保存后退出，下一次交互会话初始化时创建 provider。新环境可先启动交互 OMP，再选择插件模型；`-p`、RPC、启动参数 `--model` 和严格恢复需要宿主在启动时已能解析的模型。

默认登录 ID 为 `magpie`；显式声明 `createProvider:true` 的其他 ID 也可登录。登录不替换已有宿主 provider；插件创建的 provider 重新登录时沿用当前宿主地址。已有 provider 的用量连接使用配置向导。

## 为已有 provider 配置用量

在 TUI 中输入：

```text
/magpie setup
```

选择已有 provider，确认页显示当前 ID、网关地址和认证来源，无需重输地址或 key。确认后核验并保存用量连接，保留其他连接；取消不保存。地址、认证和模型定义在 OMP 中管理。

在 shell 中先列候选、预览，再显式确认：

```sh
omp --no-session -p '/magpie setup --list'
omp --no-session -p '/magpie setup --provider magpie-remote'
omp --no-session -p '/magpie setup --provider magpie-remote --yes'
```

将 `magpie-remote` 替换为已有 ID。列表和预览不保存、不查询网关，也不调用模型生成；只有 `--yes` 才核验并保存。CLI 尚无可用默认模型时，先在交互会话配置，或通过 `--model` 指定已有可用模型。

## 高级连接配置

以下命令在 shell 中执行。`connections` 是 JSON 数组字符串，**每次设置都会替换整个列表**；多连接须写在同一个数组中。设置生效规则见[配置更新与重载](#配置更新与重载)。

### 附加已有 provider

只声明 OMP provider ID：

```sh
omp plugin config set omp-magpie connections '[{"providerId":"magpie-remote"}]'
```

插件从 OMP registry 读取有效地址与认证。显式连接生效后，无需先发送消息即可查询用量。更改 provider 地址后，动态模型读取和用量调和均以宿主当前地址为准。

### 显式创建缺失的 provider

```sh
omp plugin config set omp-magpie connections '[
  {
    "providerId": "magpie-remote",
    "createProvider": true,
    "baseUrl": "https://gateway.example.com/magpie"
  }
]'
omp login magpie-remote
```

`baseUrl` 仅用于 `createProvider:true` 且 provider 缺失时的创建。已有 provider 始终读取 OMP 的有效地址。新建 ID 必须以小写字母开头，只包含小写字母、数字和连字符。

原生登录保存认证；已有宿主凭据时可直接使用，本机无鉴权网关可跳过登录。重启后通过 `/model` 选择模型；CLI 启动模型和严格恢复仍需宿主预先可解析的 provider。

### 配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `autoAttach` | `true` | 识别启动时已有的 `magpie` 和当前 Magpie provider；其他未声明 provider 在首次请求前识别 |
| `connections` | `[]` | 显式连接列表，不受 `autoAttach` 影响 |

每个连接的字段：

| 字段 | 说明 |
| --- | --- |
| `providerId` | 必填，OMP provider ID |
| `createProvider` | 默认 `false`；允许创建缺失 provider，不覆盖已有 provider |
| `baseUrl` | 仅显式创建时提供，作为缺失 provider 的创建地址 |

创建地址接受 HTTP/HTTPS URL，不得含 query、fragment 或用户名密码；保留代理路径前缀。普通附加仅需 `providerId`，地址及认证在 OMP 中配置。

只使用显式连接时可关闭自动识别：

```sh
omp plugin config set omp-magpie autoAttach false
```

### 宿主认证与模型

已有 provider 的 `apiKey` 可在 OMP 的 `models.yml` 中配置，支持 `!command`、环境变量名和字面值。解析、缓存与凭据优先级由 OMP 负责，规则见 [Providers](https://omp.sh/docs/providers#credential-precedence) 和 [Custom models](https://omp.sh/docs/custom-models#add-authentication)。

插件核对推理、原生 usage collector 和模型 headers 的有效认证。不同 key 的预算不混用；需要不同 key 时建立独立 provider。多会话共享连接时，各自释放引用；冲突身份不会覆盖已有用量绑定。

新建 provider 从 Magpie 读取聊天模型、模态、reasoning、必要 token 上限与价卡，支持 Anthropic Messages、OpenAI Responses、OpenAI Completions 三种协议。已有 provider 的模型定义仍由 OMP 管理。

## 配置更新与重载

`/magpie setup` 确认保存后立即应用当前会话。通过 `omp plugin config set` 在外部修改的插件设置，在会话启动或切换时重新读取；需要立即应用时可重新启动 OMP。

在已验证的 OMP 18.12.6 中，`/reload-plugins` 重新发现 skills、文件命令和 agents，并重新连接 MCP；它不会重新导入本插件的 TypeScript 代码，也不会触发本插件重读设置。首次安装、版本更新、停用或卸载后，重新启动 OMP 进程使变更完整生效。

## 用量与估价边界

- 账号配额与 key 预算分别查询。没有账号配额查看权限时，仍展示该 key 有权读取的预算。
- “当前 key 未设置预算”仅描述 key 预算。未知额度、读取失败或空数据均有说明，不显示为无限额度。
- 余额保留服务端币种，不把非美元余额换算成美元；账号、来源和窗口信息保留在原生报告中。
- 标准价卡由 USD/token 转成 OMP 的 USD/百万 tokens；扩展价卡可表达单个长上下文阶梯。多阶梯和 1 小时缓存价格无法完整映射，缺价不表示免费。
- OMP 动态构造决定最终成本和模型上限，可能调整插件提交的值。动态模型刷新失败时，宿主可能回填缓存；这些宿主行为不作为插件创建失败条件。模型列表或参考价格未更新时，可刷新模型或重启 OMP。
- 成本为参考估算，实际预算、权限和扣费以 Magpie 服务端为准。

## 常见问题

### 切换模型后没有 Magpie 用量

确认网关可达。未列入 `connections`、名称也不是 `magpie` 的 provider，在首次请求前才自动识别；需要切换后立即查询时，先显式声明连接并重启。关闭 `autoAttach` 后仅处理显式连接。

### 提示凭据冲突

检查宿主有效推理凭据、已保存账号和模型 headers 是否属于同一 gateway key。插件不会以另一把 key 查询预算，也不会更改宿主推理认证。

### 创建后缺少模型

插件仅接入聊天模型，目录必须提供必要上下文与输出上限；缺失或无效时会给出诊断。最终模型元数据由 OMP 构造。

### 配置修改未立即反映

先按[配置更新与重载](#配置更新与重载)应用插件设置。宿主 `apiKey` 引用的解析与命令缓存遵循 OMP 规则；在外部 shell 修改环境变量不会改变已运行进程的环境。原生用量缓存命中时不会重新请求，插件在会话、真实请求与实际用量读取入口核对身份。

## 更新、停用与卸载

```sh
omp plugin marketplace update huspx-agent-plugins
omp plugin upgrade omp-magpie@huspx-agent-plugins --scope user
```

停用或卸载：

```sh
omp plugin disable omp-magpie@huspx-agent-plugins --scope user
omp plugin uninstall omp-magpie@huspx-agent-plugins --scope user
```

操作后的生效方式见[配置更新与重载](#配置更新与重载)。安装时使用 `--scope project` 的，管理时也使用相同范围。

## 许可证

[MIT](LICENSE)
