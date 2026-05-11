# Shopee 选品助手

针对 Shopee 卖家的「浏览即决策」工具：装上 Chrome 扩展，在 Shopee 商品页右侧自动浮出**完整商品档案 + AI 选品建议**，数据同步上传本地后端做沉淀。

> 这是战略提案里目标产品的 MVP Demo。技术验证（CDP 监听器）已归档到 `poc/`。

---

## 截图能看到的东西

打开任意 Shopee 商品页 → 右侧侧栏自动弹出，包括：

- **核心指标**：评分 / 累计销量 / 当前折扣 / 上架时长
- **商品档案**：价格、规格、品牌、类目路径
- **品种 (variants)**：不同型号/规格的库存与价格
- **商品描述**：卖家长描述全文
- **用户评价**：跨 1-5 星累积去重的真实评论（跟随用户在 Shopee 页面切换的星级 tab 自动同步）
- **AI 选品分析**（点按钮触发）：基于评论样本和销量数据生成 优点 / 缺点 / 改良建议 / 决策结论

---

## 目录结构

```
crawler/
├── extension/                  Chrome MV3 扩展（产品形态）
│   ├── manifest.json
│   ├── content.js              注入页面：拦截 Shopee API + 渲染侧栏 + 上传后端
│   ├── page_hook.js            主世界脚本：hook window.fetch
│   ├── styles.css              侧栏样式（暖色调 + Shopee 橙）
│   ├── popup.html / popup.js   工具栏弹窗（显示后端连通状态）
│
├── backend/                    Flask 后端
│   ├── server.py               /api/collect 收数据 · /api/analyze 调 LLM
│   └── requirements.txt
│
├── poc/                        早期技术验证（已归档，非产品路径）
│   ├── cdp_listener.py         通过 Chrome 调试端口被动监听
│   ├── parser.py               raw JSON → Excel/CSV
│   ├── setup.ps1               启动带 9222 端口的 Chrome
│   └── requirements.txt
│
├── data/
│   ├── extension_collected/    扩展上传的数据（.gitignore'd）
│   ├── raw/                    CDP 监听器抓的 raw JSON
│   └── output/                 parser 生成的 Excel/CSV
│
├── docs/                       团队战略 / 架构文档
└── .gitignore
```

---

## 快速上手

### 1. 启动后端

```powershell
cd backend
pip install -r requirements.txt

# 配 LLM（chatanywhere 中转，兼容 OpenAI SDK）
$env:OPENAI_API_KEY = "sk-xxxxxxxx"
$env:OPENAI_API_BASE = "https://api.chatanywhere.tech/v1"
$env:OPENAI_MODEL = "gpt-5.4-mini"     # 可选，默认就是这个

python -X utf8 -u server.py
```

看到以下输出即就绪，**保留这个窗口**：
```
Shopee 选品助手 - 数据采集 + AI 分析后端
 数据目录: .../data/extension_collected
 LLM 状态: 就绪
 监听: http://localhost:5000
```

### 2. 安装扩展

打开 Chrome → 地址栏输入 `chrome://extensions/`：

1. 右上角开启「**开发者模式**」
2. 点「**加载已解压的扩展程序**」
3. 选 `crawler/extension/` 文件夹
4. 工具栏出现 🎯 选品助手 图标

### 3. 用

- 打开 `https://shopee.tw/` 并登录
- 点开**任意商品详情页** → 右侧自动弹出侧栏
- 在 Shopee 自带的评论星级 tab 上点 1★/2★/3★/4★/5★ → 侧栏跟着切换，并累积去重
- 点侧栏上的「**生成 AI 选品分析**」→ 调 LLM 出报告

后端窗口会持续打印每条上传记录：
```
[0042] pdp       | 三養辣雞拌麵 韓國原裝...
[0043] ratings   | 6 reviews
[AI ] 三養辣雞拌麵 ... | reviews=24 (低星 7) | verdict: 谨慎做
```

---

## 工作原理

### 数据采集链路

```
Shopee 页面
   │
   │ fetch() 调 /api/v4/pdp/get_pc / get_ratings / search_items / recommend/*
   ▼
page_hook.js  （主世界，override fetch，clone response）
   │
   │ window.postMessage
   ▼
content.js   （内容脚本，识别接口类型 → 渲染侧栏 + POST 后端）
   │
   ├─→ 渲染：侧栏即时更新 (PDP / 评论累积 / 星级 filter 同步)
   └─→ 上传：POST http://localhost:5000/api/collect
                                            │
                                            ▼
                                       backend/server.py
                                            │
                                            ├─→ data/extension_collected/*.json
                                            └─→ 等待 /api/analyze 触发 LLM
```

### 评论累积去重

用户在 Shopee 页面点 1★ tab → 收到 6 条 1 星评论；再点 4★ tab → 收到 6 条 4 星评论。  
扩展内部用 `Map<cmtid, review>` 跨 tab 累积，去重，并从响应数据本身推断「当前 filter」：
- 一批响应里全部都是 4 星 → 推断 filter=4，侧栏只显示 4 星
- 一批响应里星级混杂 → filter=0，按时间倒序显示全部

### AI 分析提示词约束

`backend/server.py` 的 prompt 要求模型：
- pros/cons 各 5-8 条，每条 15-35 字，必须**引用具体场景或频次**（拒绝「质量好」「性价比高」这种套话）
- decision.reasoning 100-180 字，必须**引用至少 3 个具体数字**（评分、销量、星级分布、上架月数）
- 若 1-3 星样本数为 0，必须明确写「差评样本不足，结论可信度有限」

模型默认 `gpt-5.4-mini`（可通过 `OPENAI_MODEL` 环境变量覆盖）。

---

## PoC 备选方案（poc/）

如果不想装扩展，纯被动监听抓样本：

```powershell
cd poc
pip install -r requirements.txt
.\setup.ps1                       # 启 Chrome（带 9222 端口）
# 在 Chrome 里登录 Shopee
python -X utf8 -u cdp_listener.py # 监听
# 在 Chrome 里浏览，监听器自动写 data/raw/
python parser.py                  # 解析成 data/output/products.xlsx
```

仅用于内部抓样本数据，**不是产品形态**。

---

## 常见问题

**Q: 侧栏没出现？**  
F12 → Console 看有没有 `[Shopee助手] content script 已加载`；`chrome://extensions/` 看扩展是否启用 / 有没有报错。

**Q: 侧栏出来了但是空的？**  
扩展只在**收到 Shopee API 响应**时填数据。首页/搜索页可能没数据，点进任意商品详情页应立刻有内容。F12 看有没有 `[Shopee助手] 截获 API:` 日志。

**Q: AI 分析报错 / 一直转圈？**  
- 检查后端窗口有没有 `[AI ERR]` 输出
- 确认 `OPENAI_API_KEY` 已设置且可调通（用 curl 测一下 chatanywhere）
- gpt-5 系列不支持自定义 temperature，已在代码里跳过

**Q: 切了商品后还能看到上一个商品的评论？**  
已修复：扩展会对比 PDP 的 item_id，不同就清空 `ratingsAll` Map。如还出现请 F12 Console 截图反馈。

**Q: 想加新 API 拦截？**  
改 `extension/content.js` 顶部的接口判断分支，并在 `renderPDPView` / `renderReviewsSection` 加对应渲染。

---

## Demo vs 真产品差距

**已实现：**
- ✅ MV3 扩展 + Flask 后端 + LLM 集成端到端打通
- ✅ Shopee 7 个核心 API 拦截（PDP / 评论 / 搜索 / 推荐）
- ✅ 评论跨星级累积去重 + filter 同步
- ✅ 商品详情完整字段（规格 / 描述 / variants / 评分分布）
- ✅ AI 分析提示词反套话约束

**还差（按战略提案估，6 个月工作量）：**
- ❌ 真实算法层（销量估算 / 评论聚类 / 1688 比价）
- ❌ 用户系统（注册 / 登录 / 订阅付费）
- ❌ 多平台（Lazada / 1688 / 知虾）
- ❌ 数据库 + OLAP 分析层
- ❌ Chrome Web Store 上架 + 数据合规
