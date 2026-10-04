"""Fixed-target Scholar search + openly available arXiv PDF collection demo."""
import argparse
import asyncio
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PAPERS = [
    ("1706.03762", "Attention Is All You Need"),
    ("1810.04805", "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding"),
    ("1910.10683", "Exploring the Limits of Transfer Learning with a Unified Text-to-Text Transformer"),
]


def write_state(directory, state):
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    temporary = directory / "manifest.json.tmp"
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(directory / "manifest.json")


def normalize(value):
    return re.sub(r"[^a-z0-9]", "", value.lower())


async def search_scholar(rows, save):
    from playwright.async_api import async_playwright
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from backend.browser_security import launch_browser

    async with async_playwright() as playwright:
        browser = await launch_browser(playwright)
        try:
            page = await browser.new_page()
            blocked = False
            for row in rows:
                if blocked:
                    row["search"] = {"status": "skipped_after_block"}
                    save()
                    continue
                url = "https://scholar.google.com/scholar?" + urllib.parse.urlencode({"q": '"' + row["title"] + '"'})
                result = {"query_url": url}
                try:
                    response = await page.goto(url, wait_until="domcontentloaded", timeout=25000)
                    text = await page.locator("body").inner_text(timeout=5000)
                    result["http_status"] = response.status if response else None
                    blocked = result["http_status"] in (403, 429) or bool(re.search(
                        r"unusual traffic|not a robot|automated queries|비정상적인 트래픽|로봇이 아닙니다", text, re.I
                    )) or "/sorry/" in page.url
                    if blocked:
                        result["status"] = "blocked"
                    elif response and response.status >= 400:
                        result["status"] = "http_error"
                    else:
                        links = await page.locator(".gs_rt a").evaluate_all(
                            "nodes => nodes.map(n => ({title:n.innerText,url:n.href}))"
                        )
                        matches = [link for link in links if normalize(link["title"]) == normalize(row["title"])]
                        result.update(status="matched" if matches else "no_matching_result", matches=matches)
                except Exception as error:
                    result.update(status="error", detail=str(error)[:400])
                row["search"] = result
                save()
                print(row["id"], "Scholar:", result["status"], flush=True)
                if not blocked:
                    await asyncio.sleep(2)
        finally:
            await browser.close()


def valid_pdf(data):
    # Reject HTML challenges and truncated responses; not a full semantic PDF validator.
    return data.startswith(b"%PDF-") and b"%%EOF" in data[-2048:]


def download(row, directory):
    target = directory / (row["id"] + ".pdf")
    previous = row.get("download", {})
    if target.exists():
        data = target.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if valid_pdf(data) and digest == previous.get("sha256"):
            row["download"] = {**previous, "status": "verified_existing"}
            return
        row["download"] = {"status": "local_file_conflict", "detail": "Existing file differs from manifest; preserved. Use another output directory."}
        return
    url = "https://arxiv.org/pdf/" + row["id"]
    result = {"source": "preset_arxiv_open_access", "url": url}
    temporary = target.with_suffix(".pdf.part")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "AgentBoard-PaperExample/1.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(30 * 1024 * 1024 + 1)
            result["resolved_url"] = response.url
        if len(data) > 30 * 1024 * 1024 or not valid_pdf(data):
            raise ValueError("Response is oversized, incomplete, or not a PDF")
        temporary.write_bytes(data)
        temporary.replace(target)
        result.update(status="downloaded", file=target.name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
    except urllib.error.HTTPError as error:
        result.update(status="blocked" if error.code in (403, 429) else "http_error", http_status=error.code)
    except Exception as error:
        result.update(status="error", detail=str(error)[:400])
    finally:
        temporary.unlink(missing_ok=True)
    row["download"] = result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "output")
    parser.add_argument("--retry-search", action="store_true", help="Explicitly retry previously recorded Scholar attempts")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = args.output / "manifest.json"
    state = json.loads(manifest.read_text()) if manifest.exists() else {
        "example": "Transformer → BERT → T5 (fixed targets, not automatic discovery)",
        "papers": [{"id": paper_id, "title": title, "metadata_url": "https://arxiv.org/abs/" + paper_id} for paper_id, title in PAPERS],
    }
    if [(r["id"], r["title"]) for r in state["papers"]] != PAPERS:
        parser.error("Output belongs to a different target list. Choose a new directory.")
    save = lambda: write_state(args.output, state)
    pending = [row for row in state["papers"] if args.retry_search or "search" not in row]
    if pending:
        try:
            asyncio.run(search_scholar(pending, save))
        except Exception as error:
            for row in pending:
                row["search"] = {"status": "unavailable", "detail": "Safe browser unavailable (" + type(error).__name__ + ")"}
            save()
    for row in state["papers"]:
        download(row, args.output)
        save()
        print(row["id"], "PDF:", row["download"]["status"], flush=True)
    print("Manifest:", manifest.resolve())
    return 0 if all(row["download"]["status"] in ("downloaded", "verified_existing") for row in state["papers"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
