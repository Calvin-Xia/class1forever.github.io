# class1forever

班级同学分布地图。公开页面只展示省市聚合统计；姓名和学校信息通过 Cloudflare Pages Functions + KV 在口令验证后按地区读取。

Forked from [lvris/map](https://github.com/lvris/map)

## 访问地址

- GitHub Pages: https://calvin-xia.github.io/class1forever.github.io/
- Cloudflare Pages: https://class1forever.pages.dev/

建议优先使用 Cloudflare Pages 地址。中国大陆网络环境下，GitHub Pages 可能访问不稳定。

## 当前架构

项目已经从“静态打包整份学生数据”的方式切换到 Cloudflare Pages Functions + KV：

- 公开页面只请求 `/api/map/public`，只返回省市聚合统计。
- 完整学生数据只保存在 Cloudflare KV 绑定 `CLASS_MAP_DATA` 中。
- 输入口令后，前端通过 `/api/auth/details` 建立登录状态。
- 建立登录状态后，前端再按地区请求 `/api/map/details`，只拿当前地区的姓名和学校信息。
- `js/data.js` 只作为本地上传脚本的数据来源，不再被网页直接加载。

这样做的目的，是避免把完整学生名单作为静态资源直接发给所有访问者。

## 仓库结构

- `index.html`: 页面结构、地图脚本加载顺序、底部面板结构。
- `css/main.css`: 页面样式、悬浮卡片、移动端样式。
- `js/map.js`: 地图初始化、公开数据渲染、详情查看交互。
- `functions/`: Cloudflare Pages Functions 接口。
- `shared/data-model.mjs`: 数据规范化、公开聚合统计生成逻辑。
- `scripts/upload-kv-data.mjs`: 将本地数据写入 Cloudflare KV。
- `wrangler.jsonc`: Cloudflare Pages / KV 绑定配置。
- `.dev.vars.example`: 本地开发需要的 secret 模板。
- `DEPLOYMENT.md`: 更完整的部署与排障说明。

## 常用命令

- `npm install`
  安装依赖。首次接手项目时先执行一次。

- `npx wrangler login`
  登录 Cloudflare 账号。上传 KV、启动本地 Pages 环境前需要先完成。

- `npm run build`
  运行静态安全检查，确认页面没有重新引入 `js/data.js`。

- `npm run cf:dev`
  启动本地 Pages Functions 开发环境。

- `npm run data:upload -- --dry-run`
  检查当前数据源是否能正确生成 KV 需要的两份数据。

- `npm run data:upload`
  上传生产环境数据到 Cloudflare KV。

- `npm run data:upload:preview`
  上传预览环境数据到 Cloudflare KV。

## 首次接手项目

推荐按下面顺序完成初始化：

1. 执行 `npm install`。
2. 执行 `npx wrangler login`，确认 Cloudflare 账号可用。
3. 复制 `.dev.vars.example` 为 `.dev.vars`，填入本地调试所需的 secret。
4. 检查 `wrangler.jsonc` 中的 `CLASS_MAP_DATA` 绑定、`preview_id`、`remote: true` 是否仍然指向正确环境。
5. 执行 `npm run data:upload -- --dry-run` 检查本地数据。
6. 执行 `npm run data:upload:preview`，先把预览环境数据上传到 KV。
7. 执行 `npm run cf:dev` 启动本地调试。

## 本地开发

### 1. 准备本地变量

复制 `.dev.vars.example` 为 `.dev.vars`，填入本地开发所需值：

```bash
DETAILS_PASSPHRASE=你的口令
DETAILS_SESSION_SECRET=一段足够长的随机字符串
DETAILS_HINT=前端显示的提示语，可选
```

`.dev.vars` 已在 `.gitignore` 中忽略，不会提交到仓库。

### 2. 准备数据

上传脚本支持两种数据来源：

- 环境变量 `STUDENTS_DATA`
- 本地未提交的 `js/data.js`

如果本地保留了 `js/data.js`，它只会被上传脚本读取，不会被网页直接访问。

### 3. 上传测试数据

先检查：

```bash
npm run data:upload -- --dry-run
```

再上传到 Cloudflare KV：

```bash
npm run data:upload
```

如果你希望本地开发优先读取预览环境 KV，则执行：

```bash
npm run data:upload:preview
```

### 4. 启动本地开发服务

```bash
npm run cf:dev
```

当前 `wrangler.jsonc` 已为 `CLASS_MAP_DATA` 配置 `remote: true` 和 `preview_id`。因此本地开发时，Pages Functions 会直接读 Cloudflare 上的远端 KV，而不是读一个空的本地 KV 模拟环境。

如果本地打开后看到“地图公开数据尚未配置”，通常说明预览环境 KV 里还没有 `students:public:v1`，需要先执行一次 `npm run data:upload:preview`。

## 部署方式

### GitHub 自动部署

这个仓库当前主分支是 `main`。如果你的 Cloudflare Pages 项目已经连接到这个仓库，并把 `main` 配置为 production branch，那么：

```bash
git add <需要提交的文件>
git commit -m "Your commit message"
git push origin main
```

推送完成后，Cloudflare Pages 会自动开始新的生产部署。

### 手动部署

如果需要手动发布当前版本，可以在仓库根目录执行：

```bash
npx wrangler pages deploy .
```

## 推送前检查

建议在提交前确认以下几点：

1. `.dev.vars` 没有被加入暂存区。
2. `js/data.js` 没有被加入暂存区。
3. `npm run build` 能正常通过。
4. 本地页面可以正常显示公开地图。
5. 输入正确口令后，可以查看某个地区的同学信息。
6. 浏览器 `Network` 与 `Sources` 中不存在 `js/data.js` 或整包学生名单。

## 注意事项

- 本项目数据仅供内部使用，请勿外传。
- 如果历史提交里出现过 `js/data.js` 或其他敏感文件，建议额外清理 Git 历史。
- 更完整的 Cloudflare 配置、部署与排障说明见 `DEPLOYMENT.md`。

## 许可证

MIT License
