"""
CDP 监听器：附加到 Chrome 端口 9222，监听 Shopee API 响应
"""
import asyncio
import json
import re
import sys
import time
from pathlib import Path
from playwright.async_api import async_playwright

CDP_URL = "http://localhost:9222"
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"
OUT_DIR.mkdir(parents=True, exist_ok=True)

INTERESTING_RE = re.compile(
    r"/api/v\d+/(search/search_items|search/product_search|item/get|recommend|pdp/get|shop/get|item/get_ratings)"
)


def log(msg):
    print(msg, flush=True)


captured = []
counter = 0


async def attach_to_page(page):
    global counter

    async def handle_response(resp):
        global counter
        u = resp.url
        if not INTERESTING_RE.search(u):
            return
        try:
            ctype = resp.headers.get("content-type", "")
            if "json" not in ctype:
                return
            body = await resp.json()
            err = body.get("error") if isinstance(body, dict) else None
            items = body.get("items") or [] if isinstance(body, dict) else []

            counter += 1
            record = {
                "url": u,
                "status": resp.status,
                "error": err,
                "items_count": len(items),
                "captured_at": time.time(),
                "body": body,
            }
            captured.append(record)
            fname = OUT_DIR / f"resp_{counter:04d}.json"
            fname.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")

            tag = "OK" if (not err and items) else f"err={err}"
            short = u.split("?")[0].split("/api/")[-1]
            log(f"[{counter:03d}] {tag} items={len(items)} api={short}")
        except Exception as e:
            log(f"[ERR parse] {e}")

    page.on("response", handle_response)
    log(f"[ATTACHED] {page.url[:100]}")


async def main():
    log(f"[CONNECT] {CDP_URL}")
    async with async_playwright() as p:
        try:
            browser = await p.chromium.connect_over_cdp(CDP_URL, timeout=10000)
        except Exception as e:
            log(f"[ERR] connect failed: {e}")
            return

        log(f"[OK] connected, contexts={len(browser.contexts)}")

        for ctx in browser.contexts:
            log(f"  context: {len(ctx.pages)} pages")
            for pg in ctx.pages:
                try:
                    await attach_to_page(pg)
                except Exception as e:
                    log(f"  attach err: {e}")

        for ctx in browser.contexts:
            ctx.on("page", lambda new_page: asyncio.create_task(attach_to_page(new_page)))

        log("[READY] 现在请在 Chrome 里搜索 Shopee 商品")
        log("[READY] 监听中... (Ctrl+C 停止)")

        try:
            while True:
                await asyncio.sleep(2)
                # 心跳，每 30 秒报告一次状态
                if int(time.time()) % 30 == 0:
                    log(f"[heartbeat] captured={counter}")
                    await asyncio.sleep(1)
        except KeyboardInterrupt:
            pass

        log(f"[END] total captured: {counter}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("[STOPPED]")
