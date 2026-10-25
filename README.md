# huspx-agent-plugins

面向编程助手的插件集合，通过 OMP marketplace 分发。

## 插件

| 插件 | 用途 | 兼容版本 |
| --- | --- | --- |
| [omp-magpie](plugins/omp-magpie/README.md) | Magpie 原生用量、API-key 登录与 provider 配置 | OMP >=18.4.1；运行验收版本 18.12.6 |

## 安装

```sh
omp plugin marketplace add https://github.com/huspx/agent-plugins.git
omp plugin install omp-magpie@huspx-agent-plugins --scope user
```

安装后重新启动 OMP。在已验证的 OMP 18.12.6 中，`/reload-plugins` 不会重载本插件的 TypeScript 代码。`--scope user` 对当前用户的所有项目生效；仅当前项目使用时改为 `--scope project`。连接步骤与重载范围见[插件使用指南](plugins/omp-magpie/README.md)。

## 更新

```sh
omp plugin marketplace update huspx-agent-plugins
omp plugin upgrade omp-magpie@huspx-agent-plugins --scope user
```

更新的生效方式与安装相同。使用 project 范围安装时，管理命令也使用 `--scope project`。

## 许可证

[MIT](LICENSE)
