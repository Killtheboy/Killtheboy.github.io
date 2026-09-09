# 515450 策略评分 · GitHub Pages 版

纯静态单页，无任何 CDN / 构建步骤 / 后端依赖。

## 目录内容
```
index.html        页面骨架（引用下列资源，全部用相对路径）
style.css         移动端深色样式
score_core.js     评分计算核心（node / 浏览器共用）
data.js           内置历史行情序列（window.EMBED，由 build_mobile_score.py 生成）
app.js            实时价抓取 + 补齐 + 渲染
.nojekyll         禁用 GitHub Jekyll，避免误处理
```

## 免责声明
本页仅做策略执行辅助，不构成投资建议。
