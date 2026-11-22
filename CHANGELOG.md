# 更新记录

## v1.5.0（2026-11-22）

### 修复
- `npm run serve` 改为服务 `build/`（原路径在构建后已被移走，无法启动）。
- 无 `.git` 的源码包执行普通 `npm ci` 不再因 husky 失败（`lib/prepare.js`）。
- CI 升级到 `actions/checkout@v4`、`actions/setup-node@v4`，读取 `.nvmrc`，并新增 `npm test`。
- 剩余英文提示改为中文：更新提示“有新版本可用 / 刷新 / 稍后”，撤销提示“撤销 / 关闭”。
- TIFF（Chrome/Edge/Firefox 不支持）与 PDF 输入给出明确原因；解码失败显示具体格式，并在控制台保留原始错误。
- GIF 输入提示“动图仅保留第一帧”。
- 批量处理进行中拖入新图片不再静默中止当前任务，改为提示先取消或等待完成。
- ZIP 写入真实修改时间（原固定 1980-01-01）；处理 Windows 保留名（CON、NUL、COM1…）、
  结尾的点和空格，并限制文件名长度。

### 优化
- 批量压缩多路并行：按 CPU 核数取一半（1–4 路），内存 ≤ 4 GB 的设备最多 2 路。
- 列表缩略图改为 112px 小图并逐张生成，不再把每张原图作为缩略图解码。
- 尺寸限制支持“按长边 / 按宽度”，竖图也能限制住。
- 批量缩放改用与单图模式相同的 Lanczos3 算法，失败时回退浏览器缩放。
- 新增“结果更大时保留原图”（默认关闭；启用缩放时不生效）。
- 新增“压缩未完成 (N)”和失败项“重试”，不必整批重压。
- 批量设置（格式、质量、尺寸、保留原图）保存在本机浏览器，损坏值自动回退默认。
- ZIP 文件名带时间戳：`compressed-images-YYYYMMDD-HHmmss.zip`。
- `serve.json` 和新增的 Netlify `_headers`：带哈希的 `/c/` 资源长期缓存；
  补充 COOP/COEP、nosniff、Referrer-Policy、Permissions-Policy。
- 项目名称和版本统一为 `tupian-yasuo` `1.5.0`；新增 `test:e2e`、`audit:deps` 等脚本。

### 兼容性说明
- 默认参数未变：WebP 质量 90、不缩放。旧版保存的单图设置不受影响。
- 批量设置的 `maxWidth` 字段改名为 `maxSize`（只在内存中，不影响已有存储）。
