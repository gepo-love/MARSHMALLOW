# 棉花糖机 · 试玩版（GitHub Pages 部署版）

本仓库是 [quiet-pocket-preview.pages.dev](https://quiet-pocket-preview.pages.dev) 的完整静态镜像，已做路径兼容处理，可直接上传到 GitHub 并通过 **GitHub Pages** 部署。

## 快速部署（2 种方式任选其一）

### 方式一：GitHub Actions 自动部署（推荐）

1. 把本目录下**所有文件**（含 `.nojekyll`、`.github` 目录）推送到你的 GitHub 仓库（公开仓库即可）。
2. 在仓库 **Settings → Pages** 中，将 **Build and deployment** 的 **Source** 选为 **GitHub Actions**。
3. 仓库自带 `.github/workflows/deploy.yml`，推送后会自动构建并发布到 Pages。
4. 部署完成后，访问 `https://<你的用户名>.github.io/<仓库名>/`。

### 方式二：手动分支部署

1. 把本目录所有文件推送到 GitHub 仓库（建议直接放在仓库根目录）。
2. 在仓库 **Settings → Pages** 中，将 **Source** 选为 **Deploy from a branch**，分支选 `main`，目录选 `/ (root)`。
3. 保存后等待数分钟，即可通过 `https://<你的用户名>.github.io/<仓库名>/` 访问。

> 如果希望使用根域名（`https://<你的用户名>.github.io/`），请把仓库命名为 `<你的用户名>.github.io`（例如 `zhangsan.github.io`）。

## 目录结构

```
.
├── index.html          # 入口页
├── manifest.json       # PWA 清单
├── sw.js               # Service Worker（离线缓存）
├── 404.html            # SPA 回退页
├── recovery.html       # 急救诊断页
├── offline.html        # 离线提示页
├── css/                # 样式（45 个）
├── js/                 # 业务模块（700+ 个）
├── assets/             # 图标 / 音频 / 壁纸
└── vendor/             # 第三方依赖
```

## 说明

- **路径已适配**：内部引用均已改为相对路径，根路径部署（`<用户名>.github.io`）与子路径部署（`<用户名>.github.io/<仓库名>/`）均可直接运行。
- **PWA 可离线**：部署后首次访问会自动注册 `sw.js` 缓存核心资源，支持安装到桌面。
- **AI 对话功能**：AI 接口地址（如 `/v1/chat/completions`）需在应用内「设置 → API 管理」中自行配置；本静态包不含后端。
- **本地预览**：可用任意静态服务器预览，例如 `python3 -m http.server 8000` 后访问 `http://localhost:8000`。
- **已知说明**：以下资源在源站（试玩版）本身就不存在，本镜像忠实还原，应用内会自动容错（如显示内嵌 SVG 图标或空白）：
  - `assets/icons/album/{companion,app-store,together-reading,shopping,play-together}.png`
  - `assets/icons/shopping/{luckin,mcdonalds,meituan-app}.png`
  - `assets/wallpapers/album-cat-wallpaper-v1.webp`

## 版本

- 源站构建号：`181337`
- 镜像时间：2026-09-03
