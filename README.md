# 515450 策略评分 · GitHub Pages 版

纯静态单页，无任何 CDN / 构建步骤 / 后端依赖。本目录（`mobile/`）即为可直接发布的站点根。

## 目录内容
```
index.html        页面骨架（引用下列资源，全部用相对路径）
style.css         移动端深色样式
score_core.js     评分计算核心（node / 浏览器共用）
data.js           内置历史行情序列（window.EMBED，由 build_mobile_score.py 生成）
app.js            实时价抓取 + 补齐 + 渲染
.nojekyll         禁用 GitHub Jekyll，避免误处理
```

## 兼容性（已确认可直接上 Pages）
- 所有资源用**相对路径**引用，项目页（`/仓库名/` 前缀）也能正常加载。
- 两个行情接口均已用 **HTTPS**：实时价 `https://qt.gtimg.cn`、历史补齐 `https://web.ifzq.gtimg.cn`（返回 `Access-Control-Allow-Origin: *`），GitHub Pages 的 HTTPS 页面下无混合内容拦截、可正常 fetch。
- 无本地绝对路径、无 `_` 开头文件，不会被 Jekyll 忽略；加了 `.nojekyll` 双保险。

## 发布步骤（3 选 1）
**A. 仓库根目录发布**（仓库专放这个页）
1. 把这 5 个文件（`index.html / style.css / score_core.js / data.js / app.js`）+ `.nojekyll` 推到仓库根。
2. 仓库 Settings → Pages → Source 选 `Deploy from a branch` → 分支选你的默认分支 → 目录选 `/ (root)`。
3. 等 1–2 分钟，访问 `https://<用户名>.github.io/<仓库名>/`。

**B. 仓库另有代码，只发布这个页**（推荐）
1. 把这 5 个文件放进仓库的 `docs/` 目录（如不存在则新建），连同 `.nojekyll`。
2. Pages → Source 选分支 → 目录选 `/docs`。

**C. 独立 `gh-pages` 分支**
把本目录文件推到 `gh-pages` 分支根，Pages → Source 选 `gh-pages` 分支 → `/ (root)`。

## 数据更新（重要）
页面是**静态快照**：打开时会自动抓实时价、补齐缺失交易日，但**内嵌的历史序列**（`data.js`）
是生成那天的基准。长时间不更新，页面会提示"数据基准日较旧"。

要更新历史序列：
1. 在本机回到项目根目录，运行 `python build_mobile_score.py`，它会用本地
   `515450_kline.json` / `cn_a_399317.json` 重新生成 `mobile/data.js`。
2. 把新的 `data.js` 推到仓库即可（次日 Pages 自动生效，无需重新构建）。

> 若想全自动：可加 GitHub Actions 定时跑上述脚本并提交，但需要 Actions 里能访问行情接口
> （腾讯接口可用），此处不默认提供。

## 免责声明
本页仅做策略执行辅助，所有口径来自 `strategy_v6_test.py`，不构成投资建议。
