# 发布指南

本指南面向维护者，说明本仓库 OMP marketplace 插件的发布步骤。开发规范、环境与验证命令见 [CONTRIBUTING.md](CONTRIBUTING.md)；agent 执行 Git 和发布操作的授权边界见 [AGENTS.md](AGENTS.md#执行约束)。文档中的步骤本身不授予执行权限。

## 版本与发布资料

每次修改插件版本时，在同一个发布 PR 中同步：

| 文件 | 发布时维护的内容 |
| --- | --- |
| `plugins/<插件名>/package.json` | 插件版本号 |
| [.omp-plugin/marketplace.json](.omp-plugin/marketplace.json) | 对应插件 entry 的相同版本号 |
| `plugins/<插件名>/CHANGELOG.md` | 本版本完整、可独立阅读的变更与必要的兼容说明 |
| [CHANGELOG.md](CHANGELOG.md) | 本次插件版本的仓库级变更概要 |
| 对应 README | 安装、配置、兼容范围或用户可见限制发生变化时同步更新 |

发布 tag 使用 `<插件名>/<版本号>`，例如 `omp-magpie/0.1.2`，版本号不加 `v` 前缀。开发分支命名遵循 [贡献指南](CONTRIBUTING.md#仓库与分发)，不得与发布 tag 同名。

CHANGELOG 在开发期间保留“未发布”标记。准备发布 PR 时，将本次条目整理为版本号与发布日期，例如 `## 0.1.2（YYYY-MM-DD）`，并在合并前核对日期。实际 tag 和 GitHub Release 的发布状态以执行结果为准，不在发布前提前声明这些操作已经完成；既有历史条目不因本次文档规范而批量改写。

## 发布顺序

1. **准备分支与变更。** 使用用途相符的开发分支，完成目标修复或功能、相关文档和 Review 问题，不携带无关改动。
2. **同步发布资料。** 按上文更新插件版本、marketplace entry、两份 CHANGELOG 和必要的使用说明。发布内容及版本资料一起进入 PR，避免 tag 后再补改发布内容。
3. **完成适用校验。** 按 [开发与验证](CONTRIBUTING.md#开发与验证) 执行所需检查。代码变更需通过 typecheck、单元测试和包检查；涉及宿主集成的改动还需固定版本 smoke，UI 改动按其实际界面验收。核对证据是否仍对应最终代码、配置与发布文件；内容变更后重跑受影响的检查。纯文档修改按文档检查要求处理。
4. **提交并创建 PR。** 说明具体问题、最终行为、兼容边界与实际执行的验证。若发布日期或内容在审查期间变化，合并前更新发布资料。
5. **Review 后合并到 `main`。** 确认必要问题已处理，按照仓库实际配置的审查及分支规则完成合并。
6. **确定 tag 的目标提交。** 获取合并后 `main` 的实际提交，核对其中包含预期代码、版本号及 CHANGELOG。使用 squash merge 时，以 squash 后的提交为准，不使用原功能分支的提交代替。
7. **创建并推送发布 tag。** 使用上文命名，指向已经核对的合并提交。
8. **按需创建 GitHub Release。** 基于同一个 tag，发布说明以该版本插件 CHANGELOG 为基础；如有附件，确认附件与该版本内容一致。操作入口见 [GitHub 官方发布文档](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)。

## 发布后核对

- 确认远端 tag 指向预期提交，插件 package 与 marketplace entry 的版本一致；使用 GitHub Release 时确认其绑定同一个 tag。
- 如验证公开安装或升级，遵循贡献指南的隔离环境要求，检查实际安装副本，并仅记录实际验证过的安装来源和宿主版本。
- 安装、更新和重启要求以对应插件使用指南为准；[omp-magpie 的配置更新与重载说明](plugins/omp-magpie/README.md#配置更新与重载) 是当前用户操作入口。
- 发现发布问题时准备新的修复版本，不通过移动已经发布的 tag 覆盖另一份代码。
- `npm pack --dry-run` 属于包检查，不等于已经发布 npm 包；本指南不将 npm 发布作为 marketplace 发布的隐含步骤。
