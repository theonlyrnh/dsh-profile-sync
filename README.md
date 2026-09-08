# dsh-profile-sync

> DeepSeek Harness (DSH) 多设备配置同步插件：通过私有 Git 仓库，手动 push/pull 同步模型配置、插件清单、补丁层与锁文件。API Key 永不上传。

[![npm version](https://img.shields.io/npm/v/dsh-profile-sync)](https://www.npmjs.com/package/dsh-profile-sync)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 特性

- **一次配置，多机同步**：模型配置（自定义提供方、模型列表、思考等级、上下文窗口）、插件清单、`cordis.patch.yml`、`pnpm-lock.yaml` 随私有 Git 仓库在设备间流转；
- **凭据隔离**：API Key / 同步令牌永远只存各设备本机，仓库里只有引用名（`apiKeyEnv: XXX`）；
- **敏感键防线**：push 前检查 `settings.yaml`，命中敏感键规则（password / secret / token 等）直接拒绝并点名；
- **本地备份**：pull 覆盖前把有差异的本地文件备份为 `.local-backup-<时间戳>`，绝不静默丢数据；
- **插件自动安装**：pull 后插件清单变化（或 profile 从未安装过）自动执行 `pnpm install`；
- **版本守卫**：`.sync-meta.yaml` 记录推送方 DSH 版本，设备间版本不一致时给出警告（不拦截）；
- **双入口**：Web 设置页「配置同步」卡片 + CLI（`dsh-profile-sync push/pull/status`）；
- **跨平台**：Windows / Linux / WSL2 统一逻辑，文本文件自动归一为 LF，避免 CRLF 噪声 diff；
- **无外部依赖**：Git 传输内置 isomorphic-git，设备上**不需要安装 git**。

## 同步范围

| ✅ 同步 | ❌ 永不触碰 |
|---|---|
| `settings.yaml`（含敏感键过滤） | `.credentials.yaml`（API Key、会话密钥） |
| `profiles/<name>/package.json` | `sessions/`、`storages/` |
| `profiles/<name>/cordis.patch.yml` | `node_modules/`、`sync-state/` |
| `profiles/<name>/pnpm-lock.yaml` | `.anonymous-user-id` |

## 前置条件

- Node ≥ 18（DSH 自带）；
- pnpm（`dsh plugin` 命令依赖）；
- 一个**私有** Git 仓库（推荐 GitHub）＋ 访问令牌（见下文）。

## 安装

每台设备执行一次：

```bash
dsh plugin --profile web add dsh-profile-sync
```

> `dsh plugin add` 会自动把插件加入 `dsh.profile.bundles` 并完成 pnpm 安装。
> 安装完成后**重启 dsh web**，浏览器强制刷新（Ctrl+Shift+R），设置页会出现「配置同步」。

也可以从 GitHub 源码安装（Windows 需要 git 命令，pnpm 可能需要 `allowBuilds` 放行构建脚本）：

```bash
dsh plugin --profile web add github:<你的用户名>/dsh-profile-sync
```

## 配置

### 1. 创建仓库访问令牌（GitHub）

GitHub → Settings → Developer settings → Personal access tokens：

- **Fine-grained token（推荐）**：只勾选你的私有仓库 → Repository permissions → `Contents: Read and write`；
- **Classic token（兼容旧版）**：Scopes 只勾 `repo`。

> 插件两种令牌都支持（认证时令牌同时置于用户名位与密码位）。

### 2. 写入仓库地址与令牌

**方式 A：Web 设置页（推荐）**

设置 → 配置同步 → 填写「仓库地址」（`https://github.com/<用户名>/<私有仓库名>.git`）→ 保存配置 → 粘贴令牌 → 保存 Token。

**方式 B：直接改文件**

`~/.dsh/settings.yaml`（Windows：`%USERPROFILE%\.dsh\settings.yaml`）追加：

```yaml
dsh-profile-sync:
  remote: https://github.com/<用户名>/<私有仓库名>.git
  branch: main
  credentialRef: DSH_SYNC_TOKEN
  autoInstallPlugins: true
```

`~/.dsh/.credentials.yaml` 的 `refs` 下添加（保持文件权限 600）：

```yaml
  DSH_SYNC_TOKEN: github_pat_你的令牌
```

## 使用

### 首次引导（一次性）

1. 配置最全的设备先 `push`，仓库建立基线；
2. 其他设备填好仓库地址与令牌后 `pull`：本地配置先备份再覆盖，插件自动安装；
3. 之后任何设备随时 push/pull，**无主从之分**。

### CLI

profile 的 `node_modules/.bin` 不在 PATH，用 pnpm exec 调用：

```bash
# Linux / WSL2
pnpm --dir "$DSH_HOME/profiles/web" exec dsh-profile-sync push    # 上传本地配置
pnpm --dir "$DSH_HOME/profiles/web" exec dsh-profile-sync pull    # 下载并应用远端配置
pnpm --dir "$DSH_HOME/profiles/web" exec dsh-profile-sync status  # 查看同步状态
```

```powershell
# Windows PowerShell
pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" exec dsh-profile-sync push
```

### Web

设置 → 「配置同步」卡片：上传/下载按钮、文件状态、仓库与 Token 配置、冲突提示。

### 日常纪律

**改配置前先 pull、改完即 push。** 改了不 push，下次在别处 pull 会把自己的改动挤进本地备份（不丢，但需要手动合并回）。

## 冲突与故障

| 现象 | 处理 |
|---|---|
| push 报「远端仓库已有其他设备推送的新提交」 | 先 pull 再 push |
| pull 报「本地同步工作区与远端分叉」 | 删除 `$DSH_HOME/sync-state/repo` 后重试 pull（不丢任何 DSH 配置） |
| settings.yaml 含敏感键被拒 | 按提示调整 `sensitiveKeyPatterns`，或把密钥移到凭据文件 |
| 插件自动安装失败（ERR_PNPM_IGNORED_BUILDS） | 在 profile 目录执行 `pnpm approve-builds` 批准依赖构建脚本 |
| 插件自动安装失败（MINIMUM_RELEASE_AGE） | 在 profile 目录执行 `pnpm config set minimumReleaseAge 0 --location project`，或等待新包过观察期 |
| Web 卡片报 `"unauthorized" is not valid JSON` | 浏览器登录态失效：重新登录 DSH 页面后再操作 |
| pull 后 dsh web 行为异常 | 重启 dsh web（运行中的服务不会热加载被覆盖的配置） |

## 安全说明

- 同步令牌只存在各设备本机凭据文件，请求时经 HTTPS basic 使用，不写日志；
- `/api/sync/*` 拒绝跨站请求（`sec-fetch-site: cross-site`），并与 DSH 自带认证门禁协同；
- 仓库里只有 `apiKeyEnv: XXX` 这类**引用名**，密钥本体留在本机；
- 若设备把 DSH 绑定到 0.0.0.0 且未装认证插件（如 dsh-auth-gate），`/api/sync/*` 将同网可达——请务必保留认证。

## 已知边界

- v1 为手动同步；设置变更自动 push、按设备分支等属于二期；
- 各设备 DSH 版本建议统一（当前约定 `0.1.2-rc.1`），不一致时只警告不拦截；
- 升级本插件：任一设备 `dsh plugin --profile <name> update dsh-profile-sync` 并 push 锁文件，其余设备 pull。

## 开发

```bash
git clone https://github.com/<用户名>/dsh-profile-sync.git
cd dsh-profile-sync
npm install
# 本地安装到 profile：
dsh plugin --profile web add file:$PWD
# 语法检查
node --check lib/core.js && node --check lib/cli.js && node --check lib/index.js && node --check lib/client.js
```

## License

[MIT](LICENSE)
