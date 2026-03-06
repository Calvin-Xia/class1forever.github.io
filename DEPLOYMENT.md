# 部署与开发指南

这份文档对应当前仓库的部署模型：Cloudflare Pages Functions + KV。站点仍然是公开站点，但完整学生数据不再进入任何静态产物；公开页面只读聚合数据，姓名和学校信息在口令验证后按地区读取。

## 1. 部署模型

当前线上能力拆分如下：

- `GET /api/map/public`
  返回公开的省市聚合统计，只包含人数和地区覆盖信息。

- `POST /api/auth/details`
  校验口令，成功后签发 `HttpOnly` 会话 Cookie。

- `GET /api/map/details`
  只在会话有效时返回某个省份或城市的姓名、学校信息。

- `CLASS_MAP_DATA` KV
  保存两份数据：
  - `students:raw:v1`: 完整学生数据，仅服务端读取。
  - `students:public:v1`: 公开聚合数据，供地图初始化使用。

- `npm run build`
  只做静态安全检查，防止有人把 `js/data.js` 或整包学生数据重新引回静态页面。

## 2. Cloudflare 侧准备

### 2.1 登录 Cloudflare 账号

首次在本机操作前，先确认 Wrangler 已登录：

```bash
npx wrangler login
npx wrangler whoami
```

如果 `whoami` 看不到正确账号，后续的 KV 上传和手动部署都会失败。

### 2.2 准备 KV Namespace

项目需要一个名为 `CLASS_MAP_DATA` 的 KV 绑定，生产和预览环境各用一个 namespace。

如需新建，可执行：

```bash
npx wrangler kv namespace create CLASS_MAP_DATA
npx wrangler kv namespace create CLASS_MAP_DATA --preview
```

当前仓库的 `wrangler.jsonc` 已经包含：

- 顶层 `kv_namespaces[0].binding = "CLASS_MAP_DATA"`
- 生产 `id`
- 预览 `preview_id`
- `remote: true`

`remote: true` 的作用是：本地执行 `npm run cf:dev` 时，Functions 直接读取 Cloudflare 上的远端 KV，而不是读一个空的本地模拟 KV。

如果你更换了 Cloudflare 账号或重新创建了 namespace，要同步更新 `wrangler.jsonc` 中对应的 `id` 和 `preview_id`。

### 2.3 配置 Secrets 与公开变量

必须配置两个 Secrets：

- `DETAILS_PASSPHRASE`
- `DETAILS_SESSION_SECRET`

可以在 Cloudflare Pages 控制台中设置，也可以用 Wrangler：

```bash
npx wrangler pages secret put DETAILS_PASSPHRASE
npx wrangler pages secret put DETAILS_SESSION_SECRET
```

预览环境也需要同名配置：

```bash
npx wrangler pages secret put DETAILS_PASSPHRASE --env preview
npx wrangler pages secret put DETAILS_SESSION_SECRET --env preview
```

可选变量：

- `DETAILS_HINT`

这个变量只用于前端提示，不参与安全校验。当前仓库已经在 `wrangler.jsonc` 的 `vars` 和 `env.preview.vars` 中提供了示例值；你可以按需要修改文案，但不要把真正的口令写进去。

## 3. 数据准备与上传

### 3.1 支持的数据来源

上传脚本支持两种输入方式：

1. 环境变量 `STUDENTS_DATA`
2. 本地未提交的 `js/data.js`

无论使用哪种来源，数据最终都只会进入 Cloudflare KV，不会重新生成给前端直接加载的静态文件。

### 3.2 数据格式要求

每条记录至少应包含：

- `name`
- `school`
- `province`
- `city`

示例：

```json
[
  {
    "name": "xxx",
    "school": "北京电子科技学院",
    "city": "丰台区",
    "province": "北京"
  }
]
```

脚本会在上传前做规范化处理，并生成：

- 原始明细数据 `students:raw:v1`
- 公开地图数据 `students:public:v1`

### 3.3 上传命令

先做 dry run：

```bash
npm run data:upload -- --dry-run
```

上传到生产环境：

```bash
npm run data:upload
```

上传到预览环境：

```bash
npm run data:upload:preview
```

如果你想显式指定本地数据文件，可以附加 `--source`：

```bash
npm run data:upload -- --source path/to/data.js
```

推荐流程是：

1. `npm run data:upload -- --dry-run`
2. `npm run data:upload:preview`
3. 本地验证无误后，再执行 `npm run data:upload`

## 4. 本地开发

### 4.1 准备 `.dev.vars`

复制 `.dev.vars.example` 为 `.dev.vars`，至少填入：

```bash
DETAILS_PASSPHRASE=你的口令
DETAILS_SESSION_SECRET=一段足够长的随机字符串
DETAILS_HINT=前端提示语，可选
```

`.dev.vars` 只用于本地开发，不应提交到仓库。

### 4.2 启动本地 Pages 环境

```bash
npm run cf:dev
```

不要用 `python -m http.server` 代替这个命令。静态服务器只能打开页面，无法提供 `/api/*` Functions 路由，也无法验证口令流程。

### 4.3 为什么本地会提示“地图公开数据尚未配置”

如果你在本地打开页面时看到这条提示，一般有两个原因：

1. 预览环境 KV 里还没有 `students:public:v1`
2. `wrangler.jsonc` 中的 `preview_id` 指向了错误的 namespace

优先检查：

```bash
npm run data:upload:preview
```

如果上传成功但页面仍然为空，再检查 `wrangler.jsonc` 是否仍然指向正确的预览 KV。

### 4.4 本地推荐验证项

至少手动验证以下内容：

1. 匿名访问时地图可正常显示，且页面源码中没有 `js/data.js`
2. 开启详情模式后，输入正确口令可以查看地区详情
3. 错误口令会返回失败提示
4. 钻取省份和城市时，详情面板能正确更新

## 5. GitHub 推送与自动部署

如果 Cloudflare Pages 已连接这个 GitHub 仓库，并把 `main` 设置为 Production branch，那么推送到 `main` 就会自动触发线上部署：

```bash
git add <需要提交的文件>
git commit -m "Update deployment docs"
git push origin main
```

如果你希望先走预览分支，可以使用普通功能分支：

```bash
git checkout -b codex/update-docs
git push -u origin codex/update-docs
```

前提是 Pages 项目已经开启 Preview branch 部署。

## 6. Cloudflare Pages 项目设置

建议确认以下设置：

- Production branch: `main`
- Build command: `npm run build`
- Build output directory: `.`
- Automatic deployments: 已开启

如果这里的 Build command 仍然是旧的静态打包命令，请改成当前的 `npm run build`。

## 7. 手动部署

如果临时需要不用 Git 集成、直接发布当前目录内容，可以执行：

```bash
npx wrangler pages deploy .
```

手动部署前同样建议先执行：

```bash
npm run build
```

## 8. 发布后检查

每次发布后，至少确认以下几点：

1. 地图首页能够正常加载并显示公开人数统计
2. 浏览器 `Network` 和 `Sources` 中不存在 `js/data.js` 或完整学生名单
3. 输入正确口令后，可以查看某个省份或城市的同学信息
4. 输入错误口令返回失败提示，连续错误超过阈值会被限制
5. 删除或篡改 Cookie 后，再请求详情会被拒绝
6. 预览环境和生产环境都已配置对应的 KV 与 Secrets

## 9. 常见问题

### 9.1 `wrangler kv bulk put failed with exit code unknown`

常见原因有三类：

1. 当前终端环境拦截了 `wrangler` 的子进程执行
2. 本机没有完成 `wrangler login`
3. 当前账号没有目标 namespace 的权限

排查顺序建议是：

```bash
npx wrangler whoami
npm run data:upload -- --dry-run
npm run data:upload
```

如果是在受限沙箱里运行，有时不是 Cloudflare 配置错，而是本地执行权限不足。

### 9.2 推送到 GitHub 后没有自动部署

检查：

1. Cloudflare Pages 项目是否仍然绑定当前 GitHub 仓库
2. Production branch 是否仍然是 `main`
3. 是否误用了跳过 CI 的 commit message
4. Cloudflare Pages 的 Build settings 是否仍是当前项目配置

### 9.3 本地详情功能一直拿不到数据

优先检查：

1. `.dev.vars` 是否存在且值完整
2. `DETAILS_PASSPHRASE` 是否和远端环境一致
3. `preview_id` 是否正确
4. 是否先执行了 `npm run data:upload:preview`

## 10. 敏感数据处理建议

- 不要提交 `.dev.vars`、`.dev.vars.*`、`js/data.js`
- 不要把完整学生数据重新写回 `index.html`、`js/` 或其他静态资源
- 如果曾经误提交过敏感数据，建议清理 Git 历史后再继续公开托管
- 在分享预览链接或生产链接前，先手动检查浏览器网络请求，确认不会下发整包明细
