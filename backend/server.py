"""
后端：接收扩展上传的商品数据 + 调用 LLM 做分析
启动：python backend/server.py
"""
import json
import os
import time
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS
from openai import OpenAI

app = Flask(__name__)
CORS(app)

DATA_DIR = Path(__file__).parent.parent / "data" / "extension_collected"
DATA_DIR.mkdir(parents=True, exist_ok=True)

stats = {"count": 0, "by_kind": {"pdp": 0, "search": 0, "ratings": 0, "recommend": 0}}

# === LLM 配置（chatanywhere 兼容 OpenAI） ===
LLM_API_KEY = os.environ.get("OPENAI_API_KEY", "")
LLM_API_BASE = os.environ.get("OPENAI_API_BASE", "https://api.chatanywhere.tech/v1")
LLM_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.4-mini")

if LLM_API_KEY:
    llm = OpenAI(api_key=LLM_API_KEY, base_url=LLM_API_BASE)
else:
    llm = None


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "llm_available": bool(llm),
        "llm_model": LLM_MODEL if llm else None,
        **stats,
    })


@app.route("/api/collect", methods=["POST"])
def collect():
    payload = request.get_json(force=True, silent=True) or {}
    kind = payload.get("kind", "unknown")
    page_url = payload.get("page_url", "")
    body = payload.get("body", {})

    stats["count"] += 1
    stats["by_kind"][kind] = stats["by_kind"].get(kind, 0) + 1

    ts = int(time.time() * 1000)
    fname = DATA_DIR / f"{kind}_{ts}.json"
    fname.write_text(
        json.dumps(
            {"kind": kind, "page_url": page_url, "collected_at": payload.get("collected_at"), "body": body},
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )

    summary = _summarize(kind, body)
    print(f"[{stats['count']:04d}] {kind:9s} | {summary}", flush=True)

    return jsonify({"ok": True, **stats})


@app.route("/api/analyze", methods=["POST"])
def analyze():
    """接收扩展前端发来的 pdp + reviews（已按 cmtid 去重），调 LLM 深度分析"""
    if not llm:
        return jsonify({"ok": False, "error": "未配置 OPENAI_API_KEY 环境变量"}), 500

    payload = request.get_json(force=True, silent=True) or {}
    pdp = payload.get("pdp") or {}
    reviews = payload.get("reviews") or []

    item = ((pdp.get("data") or {}).get("item") or pdp.get("item") or {})
    pdp_review = (pdp.get("data") or {}).get("product_review") or {}

    if not item:
        return jsonify({"ok": False, "error": "缺少商品详情数据"}), 400

    name = item.get("title") or item.get("name") or ""
    price = item.get("price") or 0
    price_real = price / 100000 if price else 0
    currency = item.get("currency", "")
    rating = pdp_review.get("rating_star") or (item.get("item_rating") or {}).get("rating_star")
    sold_display = pdp_review.get("historical_sold_display") or pdp_review.get("sold_count_display") or "(未知)"
    total_rating_count = pdp_review.get("total_rating_count")
    cmt_count = pdp_review.get("cmt_count")
    brand = item.get("brand", "")
    discount = item.get("show_discount") or 0
    ctime = item.get("ctime")
    listed_date = ""
    months_listed = None
    if ctime:
        try:
            from datetime import datetime
            d = datetime.fromtimestamp(int(ctime))
            listed_date = d.strftime("%Y-%m-%d")
            months_listed = round((time.time() - int(ctime)) / (30 * 24 * 3600), 1)
        except Exception:
            pass

    categories = [c.get("display_name", "") for c in (item.get("categories") or [])]
    category_path = " > ".join([c for c in categories if c])

    # 按星级分类统计 + 抽样
    star_buckets = {1: [], 2: [], 3: [], 4: [], 5: []}
    for r in reviews:
        star = r.get("rating_star") or r.get("rating")
        if star in star_buckets:
            txt = (r.get("comment") or "").strip()
            if txt:
                star_buckets[star].append(txt)

    star_counts = {s: len(v) for s, v in star_buckets.items()}
    total_with_text = sum(star_counts.values())

    # 评论展示给 LLM：每个星级最多 8 条，1-3 星优先（差评通常更有信息量）
    sample_lines = []
    for star in [1, 2, 3, 4, 5]:
        for txt in star_buckets[star][:8]:
            sample_lines.append(f"[{star}星] {txt[:280]}")
    review_block = "\n".join(sample_lines) if sample_lines else "(尚未抓取到评论文本)"

    # 全站评分分布（1-5星各多少条）
    rating_count_arr = pdp_review.get("rating_count") or []
    star_dist_str = ""
    if isinstance(rating_count_arr, list) and len(rating_count_arr) >= 6:
        # rating_count[0] = 总数, [1..5] 对应 1-5 星
        star_dist_str = (
            f"全站星级分布：5★ {rating_count_arr[5]} | 4★ {rating_count_arr[4]} | "
            f"3★ {rating_count_arr[3]} | 2★ {rating_count_arr[2]} | 1★ {rating_count_arr[1]}"
        )

    prompt = f"""你是一名资深跨境电商选品分析师，专攻 Shopee 平台。请基于真实数据给出**深度、有信息量**的分析，不要套话。

# 商品基本面
- 名称: {name}
- 价格: {currency} {price_real}
- 平均评分: {rating}
- 累计销量: {sold_display}
- 评论总数: {total_rating_count}（其中有内容评论 {cmt_count}）
- 上架日期: {listed_date}（已上架 {months_listed} 个月）
- 当前折扣: {discount}%
- 品类: {category_path}
- 品牌: {brand}

{star_dist_str}

# 本次抓到的评论样本（共 {total_with_text} 条带文本）
- 抓到分布：5★ {star_counts[5]} | 4★ {star_counts[4]} | 3★ {star_counts[3]} | 2★ {star_counts[2]} | 1★ {star_counts[1]}
- 重要：如果 1-3 星样本数为 0，必须在 decision.reasoning 里指出"低星样本不足，结论可信度有限"

{review_block}

# 你的任务（必须严格执行）

## 1. 优点 (pros) 5-8 条
- 每条 15-35 字，引用具体场景或频次
- 必须是评论里**多人提到**的具体优点
- 反例（不要写）：「质量好」「性价比高」「值得购买」（这种是套话）
- 正例：「保鲜效果好，开封后冷藏一周不变质（多条评论提及）」

## 2. 缺点 (cons) 5-8 条
- 必须基于 1-3 星差评里的**具体抱怨**
- 每条 15-35 字，包含具体问题描述
- 反例：「服务差」「品质一般」
- 正例：「卷後价格亂跳，发货拆包出货东一個西一個」（直接引用 1 星用户原话核心）
- 如果差评样本为 0，写「(差评样本不足，无法分析)」一条即可

## 3. 改良建议 (improvements) 4-6 条
- 必须**针对真实差评**给出可落地动作
- 每条 15-35 字，包含具体改良方向
- 反例：「提升品质」「优化服务」
- 正例：「整合发货流程，避免多商品分批拆开发出（针对发货拆包痛点）」

## 4. 决策 (decision)
verdict 选一个：建议做 / 谨慎做 / 不建议做 / 改良版切入

reasoning 要求：
- 100-180 字
- 必须**引用至少 3 个具体数字或现象**（评分、销量、上架时长、星级分布、价格档位等）
- 必须给**具体打法建议**（不是空话）
- 如果差评样本不足，必须明确说明这点对结论的影响

# 输出
仅输出严格 JSON，无 markdown，无解释：
{{
  "review_cluster": {{
    "pros": ["..."],
    "cons": ["..."],
    "improvements": ["..."]
  }},
  "decision": {{
    "verdict": "...",
    "reasoning": "..."
  }},
  "review_stats": {{
    "total_with_text": {total_with_text},
    "by_star": {{"1": {star_counts[1]}, "2": {star_counts[2]}, "3": {star_counts[3]}, "4": {star_counts[4]}, "5": {star_counts[5]}}},
    "low_star_samples": {star_counts[1] + star_counts[2] + star_counts[3]}
  }}
}}"""

    try:
        # gpt-5 系列不支持自定义 temperature，去掉
        kwargs = {
            "model": LLM_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "response_format": {"type": "json_object"},
        }
        # gpt-5 / o1 / 部分 reasoning 模型不支持 temperature
        if not (LLM_MODEL.startswith("gpt-5") or LLM_MODEL.startswith("o1") or LLM_MODEL.startswith("o3")):
            kwargs["temperature"] = 0.3
        resp = llm.chat.completions.create(**kwargs)
        text = resp.choices[0].message.content
        result = json.loads(text)
        verdict = result.get("decision", {}).get("verdict", "?")
        print(f"[AI] {name[:40]} | reviews={total_with_text} (低星 {star_counts[1]+star_counts[2]+star_counts[3]}) | verdict: {verdict}", flush=True)
        return jsonify({"ok": True, **result})
    except Exception as e:
        print(f"[AI ERR] {e}", flush=True)
        return jsonify({"ok": False, "error": str(e)}), 500


def _summarize(kind, body):
    try:
        if kind == "pdp":
            data = body.get("data", body) if isinstance(body, dict) else {}
            item = data.get("item", data) if isinstance(data, dict) else {}
            name = item.get("title") or item.get("name") or "???"
            return f"{name[:40]}"
        elif kind == "search":
            items = body.get("items", []) if isinstance(body, dict) else []
            return f"{len(items)} items"
        elif kind == "ratings":
            data = body.get("data", {}) if isinstance(body, dict) else {}
            n = len(data.get("ratings", [])) if isinstance(data, dict) else 0
            return f"{n} reviews"
        elif kind == "recommend":
            return "(推荐位)"
    except Exception:
        pass
    return ""


if __name__ == "__main__":
    print("=" * 60)
    print(" Shopee 选品助手 - 数据采集 + AI 分析后端")
    print(f" 数据目录: {DATA_DIR}")
    print(f" LLM API:  {LLM_API_BASE}")
    print(f" 模型:     {LLM_MODEL}")
    print(f" LLM 状态: {'就绪' if llm else '未配置 OPENAI_API_KEY'}")
    print(" 监听: http://localhost:5000")
    print("=" * 60)
    app.run(host="127.0.0.1", port=5000, debug=False)
