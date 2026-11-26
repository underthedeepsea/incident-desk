# 部署与运维

以下命令均从项目根目录执行。

工单、字段历史、导入批次、关联、账号、角色和会话写入 `/data/workspace.sqlite3`。SQLite 使用 WAL，主库、`-wal` 和 `-shm` 会出现在同一个可写的 `/data` 目录。Kubernetes 将整个目录挂到 PVC。Pod 重建后挂回同一 PVC，工单和历史继续可查。请让生产部署始终指向这块 PVC。

选用可重新挂载的块存储 CSI，将卷作为文件系统使用。避免使用 NFS 或其他共享网络文件系统运行 WAL。模板采用 `ReadWriteOnce`、单副本和 `Recreate`。RWO 允许同一节点的多个 Pod 访问卷，应用仍需要配置为单一写入实例。CSI 支持 `ReadWriteOncePod` 时，可将新 PVC 改用该访问模式。升级、重启、暂停均保留 PVC。旧节点状态不明时，先确认旧写入实例已停止及存储已解除挂载，再启动接管的 Pod。

## 镜像与 Kubernetes 配置

在本目录用生产环境的镜像构建工具执行。标签由部署方管理，建议为每个版本使用不可变标签或镜像摘要。

```bash
docker build -t registry.example.com/operations/incident-desk:v2-production-1 .
```

[Dockerfile](../Dockerfile) 使用官方 Node 24 LTS 的 Debian slim 镜像。构建时通过 `npm ci` 安装锁定的 XLSX 依赖，需要访问 npm Registry 和 SheetJS CDN。服务通过 `node server.cjs` 启动并在本机读取表格。进程 UID/GID 均为 `1000`。镜像只复制运行文件，`/data` 是只读的挂载占位目录，且没有自动创建匿名卷。挂入可写 PVC 后，服务会在空目标创建生产库。使用默认 `INCIDENT_DB` 时，漏挂卷或卷权限不正确会使启动失败。Pod 的根文件系统只读，`fsGroup: 1000` 用于支持卷权限管理的 CSI。确认卷根目录能由 UID/GID 1000 创建文件，服务以 `0600` 创建数据库。已有卷的文件所有者也须兼容此 UID。

在部署副本替换以下配置。

| 文件 | 部署值 |
| --- | --- |
| `k8s/kustomization.yaml` | 镜像地址和版本，以及完整的 HTTPS 源 `PUBLIC_ORIGIN`，例如 `https://tickets.example.com`，不带末尾斜线。处置时限可用 `SLA_P1_HOURS` 至 `SLA_P4_HOURS` 设置，模板为 2、8、24、72 小时，临期窗口固定为一小时。配置变更经 Kustomize 触发 Deployment 替换，并用于按原起算时间计算当前工单时限。 |
| `k8s/workload.yaml` | 将 `block-csi` 替换为实际的块存储 StorageClass，并按数据量设置 PVC 容量。PVC 应能容纳主库、WAL 以及备份暂存文件。 |
| `k8s/ingress.yaml` | 设置实际 Ingress class、域名和同一命名空间的 TLS Secret 名称。TLS 终止在 Ingress，保留 HTTPS 客户端的原始 Host，并配置 HTTP 到 HTTPS 的跳转或禁用 HTTP 业务入口。应用 Service 为 ClusterIP。导入请求体上限为 64 MiB，Ingress 控制器也须放行所需大小。8 MiB XLSX 经 Base64 编码后需要约 11 MiB 请求体。 |

模板包含 PVC、Deployment、ClusterIP Service、TLS Ingress 和生成的 ConfigMap。TLS 证书、私有镜像拉取权限及命名空间由生产平台提供。先渲染复核，确认目标上下文后再部署。

```bash
desk_namespace=operations
kubectl kustomize k8s
kubectl -n "$desk_namespace" apply -k k8s
kubectl -n "$desk_namespace" rollout status deployment/incident-desk --timeout=180s
curl --fail --silent --show-error https://tickets.example.com/healthz
```

健康入口返回 `{"status":"ok"}`，也供 kubelet 在 Pod 端口访问。应用需要明确的 HTTPS 业务 Host，同源校验使用 `PUBLIC_ORIGIN`，登录会话通过 Secure、HttpOnly Cookie 传送。生产库初始为空。

## 初始化和账号维护

在受控终端通过标准输入创建首位管理员。以下命令用 Bash 运行，管理员使用实名和单独账号，临时密码至少 15 个字符。请通过内部受控渠道交付临时密码。

```bash
read -r -s -p '首位管理员临时密码：' desk_bootstrap_password
printf '\n'
printf '%s' "$desk_bootstrap_password" | kubectl -n "$desk_namespace" exec -i deployment/incident-desk -- node admin.cjs bootstrap ops.admin '管理员实名'
unset desk_bootstrap_password
```

访问生产 HTTPS 域名并登录。首登需要更改临时密码。管理员可以从左侧「账号与权限」创建、改名、分配角色、停用和重置密码，也可以在「角色与功能」配置自定义角色。账号始终分配一个角色。

| 角色 | 可执行的功能 |
| --- | --- |
| 管理员 | 查看工作台、工单、时间线、关联和导入批次，执行全部业务操作，管理账号与角色。系统始终保留至少一名启用的管理员。 |
| 操作员 | 查看并执行全部业务操作，包括新建工单、编辑来源字段、处置与转派、建立或解除关联、表格导入。 |
| 只读 | 查看工作台、工单、时间线、关联和导入批次。 |
| 自定义角色 | 共享上述查看范围，可分别开启手工新建、手工编辑来源字段、处置与转派、关联和表格导入。 |

表格导入权限 `csv.import` 同时适用于 CSV 和 XLSX，允许按导入规则新建工单和更新来源字段，可与对应手工权限分别配置。负责人可选择启用且有处置权限的账号。停用、重新分配角色、更新其角色的业务权限或重置密码都会撤销既有会话。账号和角色变更在「账号与权限」的操作记录中可查。

所有管理员都无法登录时，由有权执行 `pods/exec` 的平台管理员使用同样的标准输入方式执行 `node admin.cjs recover-admin ops.admin`。该操作要求目标为启用的管理员，应用历史标记为部署端维护，人员归属可对照集群的执行审计。

## 导入告警表格

在「表格导入」选择或拖入 UTF-8 CSV 或 Excel `.xlsx` 文件。首个非空行为表头，沿用内部云 PD、混合云、GPU 的字段及别名。点击「预览合并结果」。只有一张非空可见工作表时，直接显示预览。若有多张，先选一张，再预览并确认。每次确认提交一张工作表。

XLSX 原文件上限为 8 MiB，且支持最多 32 张普通工作表、20,000 行、256 列。编号可用文本或 `000000` 等补零格式。超过 15 位有效数字的编号请从源资料按文本填写。公式使用文件中已保存的结果。遇到无结果或报错的公式，可在 Excel 修正数据或粘贴为值后重新上传。

## 字段历史在哪里

打开一条工单，进入「时间线」，可查看每次操作的登录账号与当时姓名、时间、变更来源，以及字段的改前和改后。可用「按字段筛选」查看同一字段的历次更改。空字符串显示「空值」，此前没有该字段显示「未存在」，多行保留换行。操作时间由服务器记录为 UTC 毫秒，页面显示北京时间，来源告警里的原始时间仍按原值保存。

历史覆盖新建工单、手工字段修改、处置状态与负责人、优先级、业务影响、处置说明、重开与关联，以及 CSV 和 XLSX 实际写入。批次页保留导入人、文件名、格式、XLSX 工作表、统计、冲突选值及原表格行号。重复导入保留批次记录，字段没有变化时没有新的字段变更。审计和相关工单在同一 SQLite 事务提交。改名或停用保留既往记录中的旧姓名和稳定账号标识。生产初始化不读取旧试用数据库，也没有可追补的真实旧操作者。应用没有删除工单或改写历史的入口，数据库和平台管理员权限仍能修改底层文件。

## 在线备份、重启和恢复

备份通过 SQLite 在线备份接口制作一致的单文件快照，可在单个业务 Pod 正常写入期间执行。快照包含工单、字段历史、批次、关联、账号和角色，主动清除会话。快照先在同一 PVC 的临时目录生成，然后以二进制流导出到运维端。使用 `kubectl exec` 时不要分配 TTY，也不要直接复制运行中的裸主库。最终备份放到卷外的受控存储，限制访问并保留校验值。

```bash
umask 077
desk_backup="incident-desk-$(date -u +%Y%m%dT%H%M%SZ).sqlite3"
if kubectl -n "$desk_namespace" exec deployment/incident-desk -- node backup.cjs export > "$desk_backup.partial" &&
   test -s "$desk_backup.partial"; then
  mv "$desk_backup.partial" "$desk_backup"
  sha256sum "$desk_backup" > "$desk_backup.sha256"
else
  rm -f "$desk_backup.partial"
fi
```

升级前先做上述备份，记录镜像标签、清单版本与备份校验值。角色功能版会在首次打开旧工作区时将 SQLite schema 从 1 迁移到 2。迁移采用单事务，保留原账号、角色、密码、会话、工单及审计。可用新版恢复 schema 1 备份，恢复会同时迁移并清除旧会话。旧版应用应搭配升级前的 schema 1 备份回退。更换 Kustomize 镜像引用后再次应用，核对健康、登录、工单和一条既有历史。暂停直接将 Deployment 缩到 0，再缩到 1 或重新应用清单。版本回退时核对数据库 schema 兼容性。兼容时可将镜像引用改回之前版本并保留 PVC。若版本涉及不兼容迁移，使用对应版本与升级前备份恢复到新 PVC，保留旧卷，直到确认新的入口和数据正确。

恢复时先验证备份校验值，再停止所有应用写入并确认原 Pod 完全退出。使用 `k8s/restore-pvc.yaml` 和 `k8s/restore-pod.yaml` 在新卷恢复。先替换其中的 StorageClass、容量和生产镜像。恢复 Pod 同样使用 UID/GID 1000，挂载 `incident-desk-restored-data` 到 `/data`。

```bash
sha256sum -c "$desk_backup.sha256"
kubectl -n "$desk_namespace" scale deployment/incident-desk --replicas=0
kubectl -n "$desk_namespace" get pods -l app.kubernetes.io/name=incident-desk
```

确认上一步没有显示任何原应用 Pod 后，继续以下命令。

```bash
kubectl -n "$desk_namespace" apply -f k8s/restore-pvc.yaml -f k8s/restore-pod.yaml
kubectl -n "$desk_namespace" wait --for=condition=Ready pod/incident-desk-restore --timeout=180s
kubectl -n "$desk_namespace" exec -i pod/incident-desk-restore -- node backup.cjs restore < "$desk_backup"
kubectl -n "$desk_namespace" delete pod incident-desk-restore --wait=true
```

把 `k8s/workload.yaml` 中 Deployment 的 `claimName` 从 `incident-desk-data` 改成 `incident-desk-restored-data`，重新运行 `kubectl apply -k k8s` 和上线验证。恢复入口只接受主库及其 SQLite 旁文件全部不存在的目标，验证库版本、完整性和外键后才放入目标路径。恢复后用户需重新登入，账号权限和密码回到备份时点。应用重新对外开放前，核对备份之后的账号启停与密码重置，必要时通过管理员或部署端恢复入口重新落实。

## 复验命令

使用 Node 24 LTS 和 OpenSSL 运行隔离测试。测试在临时目录生成合成数据，通过随机回环端口上的 HTTPS 代理访问正常用户入口。

```bash
npm ci --omit=dev --ignore-scripts
node --test test/production.test.cjs test/rbac.test.cjs test/xlsx-import.test.cjs
PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_EXECUTABLE=/path/to/chromium \
  node --test test/browser.test.cjs
kubectl kustomize k8s
```
