# 计算智算工单分析系统

面向值班团队的工单工作台。将内部云 PD、混合云 ARMS 和 GPU 节点告警导入后，可在同一入口跟踪工单、处置时限、导入批次和逐字段变更。

## 主要功能

- **值班处置**。筛选待认领、高优先级与临期工单，按认领、处置、提交验证和结单的流程跟进。
- **CSV 导入**。先预览字段匹配和冲突，确认后提交。批次可回查导入人、统计、冲突选值和对应原始行。
- **字段审计**。工单详情的「时间线」可以按字段筛选，查看编辑账号、发生时间、操作来源和改前改后的值。工单与审计在同一事务写入。
- **功能权限**。管理员从左侧「账号与权限」维护账号，并为自定义角色配置新建、编辑来源字段、处置与转派、关联和 CSV 导入权限。

| 内置角色 | 权限 |
| --- | --- |
| 管理员 | 所有工单功能与账号、角色管理 |
| 操作员 | 查看、新建、编辑、处置、关联和 CSV 导入 |
| 只读 | 查看工作台、工单、时间线和导入批次 |

查看是业务角色的基础权限。CSV 导入可按导入规则批量新增或更新来源字段。调整角色的业务权限会撤销受影响账号的现有会话，重新登录后使用新权限。

## 部署

运行时使用 Node.js 24 LTS 和内置 SQLite。Dockerfile 使用非 root 用户，Kubernetes 清单包含单副本 Deployment、持久卷、ClusterIP Service 和 HTTPS Ingress。

1. 从仓库的 Release 获取源码包，在已有镜像构建环境使用 [Dockerfile](Dockerfile) 构建。
2. 按照 [部署与运维指南](docs/deployment.md) 填写镜像地址、HTTPS 域名、TLS Secret、Ingress class 和块存储 StorageClass。
3. 应用 Kubernetes 清单后，通过标准输入创建首位管理员，然后访问生产 HTTPS 入口。

Kubernetes 将 PVC 挂在 `/data`，工单、角色和审计保存在 `/data/workspace.sqlite3`。线上备份通过 SQLite 导出一致快照，恢复时使用空卷。具体命令见 [部署与运维指南](docs/deployment.md#在线备份重启和恢复)。

## 本地验证

使用 Node.js 24 LTS 和 OpenSSL。测试会启动临时回环 HTTPS 服务并创建隔离的 SQLite 库。

```bash
node --test test/production.test.cjs test/rbac.test.cjs
```

浏览器测试另需 Playwright 和 Chromium。Playwright 可由 Node.js 加载，且已安装其配套 Chromium 时，路径变量可省略。

```bash
PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_EXECUTABLE=/path/to/chromium \
  node --test test/browser.test.cjs
kubectl kustomize k8s
```
