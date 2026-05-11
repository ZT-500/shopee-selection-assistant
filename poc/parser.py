"""
解析 captured_cdp/*.json，提取商品字段，输出 Excel + CSV。

用法：
    python parse.py
    python parse.py --indir captured_cdp --out products.xlsx
"""
import argparse
import json
from pathlib import Path
from datetime import datetime
import pandas as pd


def extract_search_items(body: dict) -> list:
    """从 search_items API 响应里提取商品列表。"""
    items = body.get("items") or []
    rows = []
    for it in items:
        ib = it.get("item_basic") or it
        if not isinstance(ib, dict):
            continue
        rows.append(_normalize_item(ib, source="search"))
    return rows


def extract_pdp_item(body: dict) -> list:
    """从 item/get 或 pdp/get 响应里提取单个商品。"""
    data = body.get("data") if "data" in body else body
    if not isinstance(data, dict):
        return []
    item = data.get("item") or data
    if not isinstance(item, dict):
        return []
    # 兼容 itemid / item_id 两种命名
    if "itemid" not in item and "item_id" not in item:
        return []
    return [_normalize_item(item, source="detail")]


def _g(d: dict, *keys, default=None):
    """从 dict 里按多个候选 key 取值，第一个非空就返回。"""
    for k in keys:
        v = d.get(k)
        if v is not None and v != "":
            return v
    return default


def _normalize_item(ib: dict, source: str) -> dict:
    """把不同结构的 item 统一成一行。
    兼容两种命名：
      search_items: itemid / shopid / name / sold
      pdp/get_pc:   item_id / shop_id / title / historical_sold
    """
    itemid = _g(ib, "itemid", "item_id")
    shopid = _g(ib, "shopid", "shop_id")
    name = _g(ib, "name", "title", default="")

    price_raw = _g(ib, "price", default=0) or 0
    price_min_raw = _g(ib, "price_min", default=price_raw) or price_raw
    price_max_raw = _g(ib, "price_max", default=price_raw) or price_raw
    price = price_raw / 100000 if price_raw else None
    price_min = price_min_raw / 100000 if price_min_raw else None
    price_max = price_max_raw / 100000 if price_max_raw else None

    item_url = f"https://shopee.tw/product/{shopid}/{itemid}" if shopid and itemid else ""

    images = ib.get("images") or []
    main_img = ib.get("image")
    if main_img:
        img_url = f"https://down-tw.img.susercontent.com/file/{main_img}"
    elif images:
        img_url = f"https://down-tw.img.susercontent.com/file/{images[0]}"
    else:
        img_url = ""

    rating = ib.get("item_rating") or {}
    rating_count_total = sum(rating.get("rating_count") or [0]) if isinstance(rating.get("rating_count"), list) else rating.get("rating_count")

    return {
        "itemid": itemid,
        "shopid": shopid,
        "name": name,
        "price": price,
        "price_min": price_min,
        "price_max": price_max,
        "currency": ib.get("currency") or "",
        "stock": _g(ib, "stock", "normal_stock"),
        "historical_sold": _g(ib, "historical_sold", "global_sold_count"),
        "monthly_sold": _g(ib, "sold", "monthly_sold"),
        "liked_count": ib.get("liked_count"),
        "rating_star": rating.get("rating_star"),
        "rating_count_total": rating_count_total,
        "cmt_count": ib.get("cmt_count"),
        "shop_location": ib.get("shop_location") or "",
        "brand": ib.get("brand") or "",
        "category_id": _g(ib, "catid", "cat_id"),
        "is_official_shop": ib.get("is_official_shop"),
        "is_preferred_plus_seller": ib.get("is_preferred_plus_seller"),
        "discount_pct": ib.get("show_discount") or ib.get("raw_discount"),
        "ctime": _ts_to_str(ib.get("ctime")),
        "image_url": img_url,
        "item_url": item_url,
        "source": source,
    }


def _ts_to_str(ts):
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d")
    except Exception:
        return ""


def main():
    ap = argparse.ArgumentParser()
    project_root = Path(__file__).resolve().parent.parent
    ap.add_argument("--indir", default=str(project_root / "data" / "raw"), help="输入目录（默认 ../data/raw）")
    ap.add_argument("--out", default=str(project_root / "data" / "output" / "products.xlsx"), help="输出 Excel 路径")
    args = ap.parse_args()

    indir = Path(args.indir)
    if not indir.exists():
        print(f"[ERR] 输入目录不存在: {indir}")
        return

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    files = sorted(indir.glob("resp_*.json"))
    print(f"[INFO] 发现 {len(files)} 个响应文件")

    all_rows = []
    error_count = 0
    for f in files:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  [skip] {f.name}: {e}")
            continue

        if d.get("error"):
            error_count += 1
            continue

        body = d.get("body") or {}
        url = d.get("url") or ""

        if "search_items" in url or "product_search" in url:
            rows = extract_search_items(body)
        elif "item/get" in url or "pdp/get" in url:
            rows = extract_pdp_item(body)
        else:
            rows = []

        for r in rows:
            r["_source_file"] = f.name
        all_rows.extend(rows)

    print(f"[INFO] 跳过错误响应: {error_count} 个")
    print(f"[INFO] 提取到商品: {len(all_rows)} 条")

    if not all_rows:
        print("[WARN] 没有可解析的商品数据。")
        print("       请先在 Chrome 里搜索/浏览 Shopee，让监听器抓到数据。")
        return

    df = pd.DataFrame(all_rows)
    df = df.drop_duplicates(subset=["itemid"], keep="first")
    print(f"[INFO] 去重后: {len(df)} 条")

    out_xlsx = out_path
    out_csv = out_xlsx.with_suffix(".csv")

    df.to_excel(out_xlsx, index=False)
    df.to_csv(out_csv, index=False, encoding="utf-8-sig")

    print(f"[OK] Excel: {out_xlsx.absolute()}")
    print(f"[OK] CSV:   {out_csv.absolute()}")
    print()
    print("=== 前 5 条预览 ===")
    print(df[["name", "price", "historical_sold", "rating_star", "shop_location"]].head().to_string())


if __name__ == "__main__":
    main()
