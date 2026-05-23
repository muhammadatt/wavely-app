#!/usr/bin/env python3
"""
Audacy Podcast Downloader
=========================
Scrapes the first 5 podcasts from each category on audacy.com,
then downloads the most recent episode audio from each.

Requirements:
    pip install playwright httpx
    playwright install chromium
    # For HLS (.m3u8) streams:
    brew install ffmpeg   # macOS
    sudo apt install ffmpeg  # Linux

Usage:
    python audacy_downloader.py

The script saves progress to audacy_state.json so it can resume
if interrupted. Delete that file to start fresh.

Downloads are organized as:
    audacy_downloads/
      <Category Name>/
        <podcast-slug>.<mp3|m4a|...>
"""

import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

import httpx
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

# ── Configuration ────────────────────────────────────────────────────────────

DOWNLOAD_DIR    = Path("audacy_downloads")
STATE_FILE      = Path("audacy_state.json")
DEBUG_DIR       = Path("audacy_debug")       # screenshots saved here on errors
BASE_URL        = "https://www.audacy.com"
PODCASTS_URL    = f"{BASE_URL}/podcasts"
PODCASTS_PER_CAT = 5
REQUEST_DELAY   = 2.5   # seconds between page loads — be polite
HEADLESS        = True  # set False to watch the browser

# ── Helpers ──────────────────────────────────────────────────────────────────

def sanitize(name: str) -> str:
    """Strip characters unsafe for filenames and truncate."""
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip("._")[:80]


def log(msg: str, indent: int = 0):
    print("  " * indent + msg, flush=True)


async def debug_screenshot(page, label: str):
    DEBUG_DIR.mkdir(exist_ok=True)
    path = DEBUG_DIR / f"{sanitize(label)}.png"
    await page.screenshot(path=str(path))
    log(f"📸  Screenshot saved → {path}", indent=2)


# ── Step 1: Scrape categories ─────────────────────────────────────────────────

async def scrape_categories(page) -> dict[str, list[str]]:
    """
    Returns {category_name: [podcast_url, ...]} with up to 5 URLs per category.

    Audacy renders category sections as <section> blocks, each with a heading
    and a grid of podcast cards. We look for any <a> whose href contains
    /podcast/ within each section.

    If selectors don't match after a site update, check debug_categories.png
    and adjust CATEGORY_SECTION_SEL / PODCAST_LINK_SEL below.
    """
    CATEGORY_SECTION_SEL = "section, [data-testid*='category'], [class*='CategoryRow'], [class*='category-row']"
    PODCAST_LINK_SEL     = "a[href*='/podcast/']"
    HEADER_SEL           = "h1, h2, h3, h4, [class*='title'], [class*='Title']"

    log(f"Loading {PODCASTS_URL} …")
    await page.goto(PODCASTS_URL, wait_until="networkidle", timeout=45_000)
    await page.wait_for_timeout(2000)   # let lazy-loaded content settle
    await debug_screenshot(page, "categories_page")

    sections = await page.query_selector_all(CATEGORY_SECTION_SEL)
    log(f"Found {len(sections)} potential section elements")

    categories: dict[str, list[str]] = {}

    for section in sections:
        # ── category name ──────────────────────────────────────────────────
        header_el = await section.query_selector(HEADER_SEL)
        if not header_el:
            continue
        cat_name = (await header_el.inner_text()).strip()
        if not cat_name or len(cat_name) > 80:
            continue

        # ── collect up to 5 unique podcast URLs ───────────────────────────
        link_els = await section.query_selector_all(PODCAST_LINK_SEL)
        urls: list[str] = []
        seen: set[str] = set()

        for el in link_els:
            href = await el.get_attribute("href")
            if not href:
                continue
            full = href if href.startswith("http") else BASE_URL + href
            # de-duplicate and skip episode-level links (/episode/ in path)
            if full not in seen and "/episode/" not in full:
                seen.add(full)
                urls.append(full)
            if len(urls) >= PODCASTS_PER_CAT:
                break

        if urls:
            categories[cat_name] = urls

    return categories


# ── Step 2: Extract audio URL from a podcast page ────────────────────────────

# Selectors tried in order for the "play latest episode" button
PLAY_BUTTON_SELECTORS = [
    "button:has-text('Latest episode')",
    "button:has-text('Play latest')",
    "button:has-text('Play Latest')",
    "[data-testid='play-latest']",
    "[data-testid='latest-episode-play']",
    "[aria-label*='latest' i]",
    "[aria-label*='play' i]",
    # broad fallback — first visible play button on the page
    "button[class*='play' i]",
    "button[class*='Play']",
]

async def get_audio_url(page, podcast_url: str) -> str | None:
    """
    Load the podcast page, click the latest-episode play button,
    then pull the src/currentSrc from the <audio> element.

    As a fallback we also intercept network requests so we can catch
    audio URLs that are set programmatically after the element is created.
    """
    slug = podcast_url.rstrip("/").split("/")[-1]
    captured_audio_urls: list[str] = []

    # ── network interception (catches urls before they hit <audio>) ────────
    def on_request(request):
        url = request.url
        if any(ext in url for ext in (".mp3", ".m4a", ".aac", ".ogg", ".m3u8", "/audio/", "/media/")):
            captured_audio_urls.append(url)

    page.on("request", on_request)

    try:
        await page.goto(podcast_url, wait_until="networkidle", timeout=40_000)
    except PlaywrightTimeout:
        log(f"⚠  Timeout loading {podcast_url}", indent=2)
        page.remove_listener("request", on_request)
        return None

    await page.wait_for_timeout(1500)

    # ── click play button ──────────────────────────────────────────────────
    clicked = False
    for sel in PLAY_BUTTON_SELECTORS:
        try:
            btn = await page.query_selector(sel)
            if btn and await btn.is_visible():
                await btn.click()
                clicked = True
                log(f"▶  Clicked: {sel!r}", indent=2)
                break
        except Exception:
            continue

    if not clicked:
        log(f"⚠  Could not find play button — trying to read <audio> directly", indent=2)
        await debug_screenshot(page, f"no_button_{slug}")

    # wait for <audio> element and its src to be populated
    try:
        await page.wait_for_selector("audio", timeout=12_000)
        await page.wait_for_timeout(1500)   # give src time to populate
    except PlaywrightTimeout:
        pass

    # ── read from <audio> element ──────────────────────────────────────────
    audio_src: str | None = await page.evaluate("""
        () => {
            const a = document.querySelector('audio');
            if (!a) return null;
            return a.currentSrc || a.src
                || a.querySelector('source')?.src
                || null;
        }
    """)

    page.remove_listener("request", on_request)

    # prefer the element src; fall back to intercepted network URL
    result = audio_src or (captured_audio_urls[-1] if captured_audio_urls else None)

    if result:
        log(f"🎵  Audio URL: {result[:90]}…", indent=2)
    else:
        await debug_screenshot(page, f"no_audio_{slug}")
        log(f"✗  No audio URL found for {podcast_url}", indent=2)

    return result


# ── Step 3: Download audio file ───────────────────────────────────────────────

async def download_audio(audio_url: str, dest_stem: Path) -> str | None:
    """
    Download audio_url to dest_stem.<ext>.
    Handles direct file downloads (mp3/m4a/aac) and HLS streams (.m3u8).
    Returns the local file path on success, None on failure.
    """
    dest_stem.parent.mkdir(parents=True, exist_ok=True)

    # ── HLS stream ────────────────────────────────────────────────────────
    if ".m3u8" in audio_url:
        out = dest_stem.with_suffix(".mp3")
        log(f"⬇  HLS → ffmpeg → {out.name}", indent=2)
        try:
            result = subprocess.run(
                [
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-i", audio_url,
                    "-c", "copy",
                    str(out),
                ],
                capture_output=True, text=True, timeout=600,
            )
            if result.returncode == 0:
                log(f"✓  {out} ({out.stat().st_size / 1_048_576:.1f} MB)", indent=2)
                return str(out)
            else:
                log(f"✗  ffmpeg error: {result.stderr[-300:]}", indent=2)
                return None
        except FileNotFoundError:
            log("✗  ffmpeg not found — install it to download HLS streams", indent=2)
            return None
        except subprocess.TimeoutExpired:
            log("✗  ffmpeg timed out", indent=2)
            return None

    # ── direct download ───────────────────────────────────────────────────
    parsed_path = urlparse(audio_url).path
    ext = Path(parsed_path).suffix or ".mp3"
    out = dest_stem.with_suffix(ext)

    log(f"⬇  Downloading → {out.name}", indent=2)
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/124.0.0.0 Safari/537.36",
        "Referer": BASE_URL,
    }

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, read=300.0),
            follow_redirects=True,
            headers=headers,
        ) as client:
            async with client.stream("GET", audio_url) as resp:
                if resp.status_code != 200:
                    log(f"✗  HTTP {resp.status_code}", indent=2)
                    return None
                with open(out, "wb") as f:
                    async for chunk in resp.aiter_bytes(65_536):
                        f.write(chunk)
        size_mb = out.stat().st_size / 1_048_576
        log(f"✓  {out} ({size_mb:.1f} MB)", indent=2)
        return str(out)
    except Exception as e:
        log(f"✗  Download failed: {e}", indent=2)
        return None


# ── Main ─────────────────────────────────────────────────────────────────────

async def main():
    # ── load / initialise state ────────────────────────────────────────────
    state: dict = {}
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            state = json.load(f)
        done = len(state.get("completed", []))
        log(f"Resuming — {done} podcast(s) already processed")

    completed: set[str] = set(state.get("completed", []))
    results: dict       = state.get("results", {})

    def save_state():
        state["completed"] = list(completed)
        state["results"]   = results
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)

    # ── launch browser ─────────────────────────────────────────────────────
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=HEADLESS)
        ctx = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
        )
        page = await ctx.new_page()

        # ── Step 1: categories ─────────────────────────────────────────────
        if "categories" not in state:
            categories = await scrape_categories(page)
            if not categories:
                log("⚠  No categories found — check debug_categories.png and adjust selectors")
                await browser.close()
                return
            log(f"\nFound {len(categories)} categories:")
            for cat, urls in categories.items():
                log(f"  {cat}: {len(urls)} podcast(s)")
            state["categories"] = categories
            save_state()
        else:
            categories = state["categories"]
            log(f"Using cached categories ({len(categories)} categories)")

        # ── Step 2 & 3: per-podcast ────────────────────────────────────────
        total = sum(len(v) for v in categories.values())
        processed = 0

        for cat_name, podcast_urls in categories.items():
            safe_cat = sanitize(cat_name)
            log(f"\n{'═'*55}")
            log(f"Category: {cat_name}")
            log(f"{'═'*55}")

            for podcast_url in podcast_urls:
                processed += 1
                slug = podcast_url.rstrip("/").split("/")[-1]
                log(f"\n[{processed}/{total}] {slug}")
                log(f"  URL: {podcast_url}", indent=1)

                if slug in completed:
                    log("  ⏭  Already done, skipping", indent=1)
                    continue

                # get audio url
                audio_url = await get_audio_url(page, podcast_url)
                await asyncio.sleep(REQUEST_DELAY)

                # download
                file_path = None
                if audio_url:
                    dest = DOWNLOAD_DIR / safe_cat / slug
                    file_path = await download_audio(audio_url, dest)

                # record result
                cat_results = results.setdefault(cat_name, [])
                cat_results.append({
                    "slug":        slug,
                    "podcast_url": podcast_url,
                    "audio_url":   audio_url,
                    "file_path":   file_path,
                    "success":     file_path is not None,
                })
                completed.add(slug)
                save_state()

        await browser.close()

    # ── summary ────────────────────────────────────────────────────────────
    total_ok  = sum(r["success"] for v in results.values() for r in v)
    total_all = sum(len(v) for v in results.values())

    log(f"\n{'═'*55}")
    log(f"All done!  {total_ok}/{total_all} episodes downloaded successfully")
    log(f"Files:     {DOWNLOAD_DIR.absolute()}")
    log(f"State:     {STATE_FILE.absolute()}")
    if DEBUG_DIR.exists():
        log(f"Debug:     {DEBUG_DIR.absolute()}")


if __name__ == "__main__":
    asyncio.run(main())