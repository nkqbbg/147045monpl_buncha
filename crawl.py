import json
import re
import hashlib
import logging
from urllib.parse import urljoin, urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

import requests
from bs4 import BeautifulSoup

URL = "https://phantatv.pro/soccer"
HEADERS = {"User-Agent": "Mozilla/5.0"}
MAX_WORKERS = 5

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('crawl.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


def generate_id(text):
    """Generate a short ID from text using hash"""
    if not text:
        return "item-unknown"
    hash_obj = hashlib.md5(text.encode())
    return hash_obj.hexdigest()[:12]


def clean_text(value):
    return re.sub(r"\s+", " ", value or "").strip()


def is_internal_link(link, base_domain):
    if not link:
        return False

    parsed = urlparse(link)
    if parsed.scheme and parsed.netloc:
        return parsed.netloc == base_domain
    return True


def extract_page_data(url):
    response = requests.get(url, headers=HEADERS, timeout=30)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    base_domain = urlparse(url).netloc

    title = clean_text(soup.title.get_text()) if soup.title else ""
    meta_description = ""
    description_tag = soup.find("meta", attrs={"name": "description"})
    if description_tag:
        meta_description = clean_text(description_tag.get("content", ""))

    headings = []
    for tag in soup.find_all(["h1", "h2", "h3"]):
        text = clean_text(tag.get_text(" "))
        if text and text not in headings:
            headings.append(text)

    links = []
    seen_links = set()
    for anchor in soup.find_all("a", href=True):
        href = anchor.get("href")
        absolute_href = urljoin(url, href)
        if not is_internal_link(absolute_href, base_domain):
            continue

        text = clean_text(anchor.get_text(" "))
        key = (absolute_href, text)
        if key in seen_links:
            continue

        seen_links.add(key)
        links.append({"text": text, "url": absolute_href})

    # keep original extracted data for compatibility
    live_links = [
        item for item in links
        if "/truc-tiep/" in item["url"] or "/nhan-dinh-bong-da/" in item["url"]
    ]

    return {
        "url": url,
        "title": title,
        "meta_description": meta_description,
        "headings": headings,
        "live_links": live_links,
        "internal_links": links,
    }


def extract_hot_matches(url, fetch_streams=True):
    """Fetch only matches inside elements with class .match-hot-section-container.

    If `fetch_streams` is True, follow each match link and attach `streams`.
    """
    logger.info(f"Starting to extract hot matches from {url}")
    response = requests.get(url, headers=HEADERS, timeout=30)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    containers = soup.select(".match-hot-section-container")
    logger.info(f"Found {len(containers)} match containers")
    
    matches = []
    seen = set()

    def _looks_like_status(token):
        return bool(re.match(
            r"^(LIVE|HIỆP\s*\d+|CHƯA BẮT ĐẦU|ĐANG DIỄN RA|KẾT THÚC|HOÃN|HỦY|VS|vS|Vs|vs)$",
            token,
            flags=re.I,
        ))

    def _extract_match_fields(card):
        text_blocks = [clean_text(item) for item in card.stripped_strings]
        text_blocks = [item for item in text_blocks if item]

        full_text = clean_text(card.get_text(" "))

        # Prefer dedicated selectors when they exist.
        home_name = None
        home_image = None
        away_name = None
        away_image = None
        mtime = None
        mdate = None

        # Try to find team containers (home/away)
        th = card.select_one(
            ".team-home .name-short, .team-home .name, .home .team-name, .team-home, .home-team, .team-home-name"
        )
        ta = card.select_one(
            ".team-away .name-short, .team-away .name, .away .team-name, .team-away, .away-team, .team-away-name"
        )
        
        # Extract team names
        if th:
            home_name = clean_text(th.get_text(" "))
            # Try to find image in or near team element
            th_img = th.find("img") or th.select_one("img") or (th.parent and th.parent.find("img"))
            if th_img and th_img.get("src"):
                home_image = th_img.get("src")
        if ta:
            away_name = clean_text(ta.get_text(" "))
            ta_img = ta.find("img") or ta.select_one("img") or (ta.parent and ta.parent.find("img"))
            if ta_img and ta_img.get("src"):
                away_image = ta_img.get("src")
        
        # Extract time and date
        tt = card.select_one(".time, .match-time, .time span, .match-meta .time")
        if tt:
            mtime = clean_text(tt.get_text(" "))
        
        # Look for date in text blocks or attributes (format: DD|MM or DD/MM)
        for token in text_blocks:
            if re.match(r"^\d{1,2}[/|]\d{2}$", token):
                mdate = token
                break
        if not mdate:
            date_match = re.search(r"\b(\d{1,2})[/|](\d{2})\b", full_text)
            if date_match:
                mdate = f"{date_match.group(1)}|{date_match.group(2)}"
        
        # Format time with date if both exist
        if mtime and mdate:
            mtime = f"{mtime} {mdate}"
        
        # Build structured home/away dicts
        home = None
        away = None
        if home_name or home_image:
            home = {"name": home_name, "image": home_image}
        if away_name or away_image:
            away = {"name": away_name, "image": away_image}

        if not mtime:
            time_match = re.search(r"\b\d{1,2}:\d{2}\b", full_text)
            if time_match:
                mtime = time_match.group(0)

        # Heuristic fallback for cards where team elements are not labeled.
        if not home or not away:
            filtered = []
            for token in text_blocks:
                if re.match(r"^\d{1,2}:\d{2}$", token):
                    continue
                if re.match(r"^\d{2}[/|]\d{2}$", token):
                    continue
                if token.upper().startswith("BLV"):
                    continue
                if token.upper().startswith("CƯỢC"):
                    continue
                if token in {"XEM NGAY", "Xem ngay", "CHI TIẾT", "Chi tiết trận đấu", "Xem chi tiết"}:
                    continue
                if _looks_like_status(token):
                    filtered.append(token)
                    continue
                filtered.append(token)

            # Try to use the visible card order: [league/title, home, score/status, away, ...]
            score_idx = None
            for i, token in enumerate(filtered):
                if re.match(r"^\d+:\d+$", token) or _looks_like_status(token):
                    score_idx = i
                    break

            if score_idx is not None:
                if not home and score_idx - 1 >= 0:
                    home_name_fallback = filtered[score_idx - 1]
                    home = {"name": home_name_fallback, "image": None}
                if not away and score_idx + 1 < len(filtered):
                    away_name_fallback = filtered[score_idx + 1]
                    away = {"name": away_name_fallback, "image": None}

            # If that still failed, parse using VS separators from the visible text.
            if not home or not away:
                vs_match = re.search(r"(.+?)\s+VS\s+(.+?)(?:\s+HIỆP\s+\d+|\s+CHƯA BẮT ĐẦU|\s+LIVE|\s+\d+:\d+|$)", full_text, flags=re.I)
                if vs_match:
                    if not home:
                        home_name_vs = clean_text(vs_match.group(1))
                        home = {"name": home_name_vs, "image": None}
                    if not away:
                        away_name_vs = clean_text(vs_match.group(2))
                        away = {"name": away_name_vs, "image": None}

        # Provide a readable summary text when the anchor itself is empty.
        summary_text = full_text
        if not summary_text and (home or away):
            home_str = home.get("name") if isinstance(home, dict) else home
            away_str = away.get("name") if isinstance(away, dict) else away
            summary_text = " - ".join([item for item in [home_str, away_str] if item])

        return summary_text, home, away, mtime

    for container in containers:
        for a in container.find_all("a", href=True):
            href = urljoin(url, a.get("href"))
            if href in seen:
                continue
            seen.add(href)

            # try to find a surrounding match card to pull structured info
            card = a
            for _ in range(6):
                if card is None:
                    break
                classes = card.get("class") or []
                if any(re.search(r"(cm-wrap|card-match|match-item|match)", c) for c in classes):
                    break
                card = card.parent

            anchor_text = clean_text(a.get_text())
            if card:
                card_text, home, away, mtime = _extract_match_fields(card)
                if not anchor_text:
                    anchor_text = card_text
            else:
                home = None
                away = None
                mtime = None

            # fallback: try to parse text from the summary if teams were not found
            if not (home and away) and anchor_text:
                parts = re.split(r"\s+vs\s+|\s+-\s+|\s+v\s+", anchor_text, flags=re.I)
                if len(parts) >= 2:
                    if not home:
                        home = {"name": clean_text(parts[0]), "image": None}
                    if not away:
                        away = {"name": clean_text(parts[1]), "image": None}

            matches.append({
                "link": href,
                "text": anchor_text,
                "home": home,
                "away": away,
                "time": mtime,
            })

    logger.info(f"Extracted {len(matches)} matches")

    # Optionally fetch streams for each discovered match using threading
    if fetch_streams:
        logger.info(f"Starting to fetch streams for {len(matches)} matches with {MAX_WORKERS} threads")
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            # Submit all stream fetch tasks
            future_to_match = {
                executor.submit(extract_streams_for_match, m.get("link")): m 
                for m in matches
            }
            
            # Process completed tasks as they finish
            completed = 0
            for future in as_completed(future_to_match):
                m = future_to_match[future]
                try:
                    m["streams"] = future.result()
                    completed += 1
                    logger.debug(f"[{completed}/{len(matches)}] Fetched streams for: {m.get('text', 'Unknown')[:60]}")
                except Exception as e:
                    m["streams"] = [{"type": "error", "url": None, "note": str(e)}]
                    logger.error(f"Error fetching streams for {m.get('link')}: {str(e)}")
        
        logger.info(f"Completed fetching streams for all {len(matches)} matches")

    return {"url": url, "matches": matches}


def _clean_js_json(js_text):
    # Try to coerce JS object/array into valid JSON
    s = js_text.strip()
    # remove JS comments
    s = re.sub(r"//.*?$|/\*.*?\*/", "", s, flags=re.S | re.M)
    # Replace single quotes with double quotes when safe
    s = re.sub(r"'(.*?)'", lambda m: '"' + m.group(1).replace('"', '\\"') + '"', s)
    # Remove trailing commas
    s = re.sub(r",\s*([}\]])", r"\1", s)
    return s


def extract_streams_for_match(match_url):
    """Fetch a match page and attempt to extract playable stream URLs.

    Returns a list of stream dicts: {type, url, note}
    """
    try:
        logger.debug(f"Fetching streams from: {match_url}")
        resp = requests.get(match_url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
    except Exception as e:
        logger.error(f"Failed to fetch match page {match_url}: {str(e)}")
        return [{"type": "error", "url": None, "note": str(e)}]

    text = resp.text
    soup = BeautifulSoup(text, "html.parser")

    streams = []
    seen = set()

    def add_stream(t, u, note=None, label=None):
        if not u:
            return
        u2 = urljoin(match_url, u)
        if u2 in seen:
            return
        seen.add(u2)

        # normalize protocol/label
        proto = t
        friendly = None
        lu = u2.lower()
        if ".m3u8" in lu or lu.endswith("/playlist.m3u8"):
            proto = "hls"
            friendly = "HLS (m3u8)"
        elif lu.endswith(".flv") or ".flv" in lu:
            proto = "flv"
            friendly = "FLV"
        elif lu.startswith("blob:"):
            proto = "blob"
            friendly = "Blob Video"
        elif t == "iframe":
            proto = "iframe"
            friendly = "Iframe Embed"
        elif t in ("video", "video_source"):
            proto = "video"
            friendly = "HTML5 Video"
        else:
            proto = t
            friendly = t

        if label:
            friendly = label

        streams.append({
            "protocol": proto,
            "label": friendly,
            "detected_type": t,
            "url": u2,
            "note": note,
        })
        logger.debug(f"Found stream: {friendly} ({proto})")

    # 1) video/source tags
    for src in soup.select("video source"):
        add_stream("video_source", src.get("src") or src.get("data-src"))
    for vtag in soup.select("video"):
        add_stream("video", vtag.get("src"))

    # 2) iframe embeds
    for iframe in soup.select("iframe[src]"):
        add_stream("iframe", iframe.get("src"))

    # 3) direct m3u8 links in HTML/JS
    for m in re.findall(r"https?://[^\'\"\s<>]+\.m3u8[^\'\"\s<>]*", text):
        add_stream("m3u8", m)

    # 4) look for JS variables containing JSON arrays/objects that may include sources
    js_candidates = re.findall(r"(?:var|let|const)\s+(?:sources|playerSources|serverStreamLinks|streamLinks)\s*=\s*([\[\{].*?[\]\}]);", text, flags=re.S)
    for cand in js_candidates:
        try:
            cleaned = _clean_js_json(cand)
            parsed = json.loads(cleaned)
        except Exception:
            parsed = None

        def _extract_from_obj(obj, prefix=None):
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if isinstance(v, str) and v.startswith("http"):
                        lbl = f"{k}" if k else prefix
                        add_stream("from_js", v, note="from_js", label=lbl)
                    else:
                        _extract_from_obj(v, prefix=k)
            elif isinstance(obj, list):
                for item in obj:
                    _extract_from_obj(item, prefix=prefix)

        if parsed is not None:
            _extract_from_obj(parsed)

    # 5) fallback: look for data attributes like data-src, data-href containing urls
    for tag in soup.find_all(attrs=True):
        for attr, val in tag.attrs.items():
            if not isinstance(val, str):
                continue
            if ".m3u8" in val or val.startswith("http"):
                if ".m3u8" in val:
                    add_stream("m3u8", val, note=f"attr:{attr}")
                elif val.startswith("http") and any(ext in val for ext in [".mp4", ".webm"]):
                    add_stream("direct", val, note=f"attr:{attr}")

    # 6) final heuristic: sometimes links are obfuscated in base64 inside scripts
    for b64 in re.findall(r"[A-Za-z0-9+/=]{40,}", text):
        # skip obviously non-base64
        try:
            import base64

            dec = base64.b64decode(b64).decode("utf-8", errors="ignore")
            for m in re.findall(r"https?://[^\'\"\s<>]+\.m3u8[^\'\"\s<>]*", dec):
                add_stream("m3u8", m, note="decoded_base64")
        except Exception:
            pass

    if not streams:
        logger.warning(f"No streams found for {match_url}")
        streams.append({"protocol": "none", "label": "none_found", "detected_type": "none", "url": None, "note": "no streams detected with current heuristics"})
    else:
        logger.info(f"Found {len(streams)} stream(s) for match")

    return streams


def transform_matches_to_template(matches_data, template_base=None):
    """Transform extracted matches data into template.json compatible format"""
    
    if template_base is None:
        template_base = {
            "id": "buncha-live",
            "url": "https://tt.8share.pro/buncha",
            "name": "Bun Cha TV Live",
            "color": "#e86281",
            "grid_number": 3,
            "image": {
                "type": "cover",
                "url": "https://raw.githubusercontent.com/nkqbbg/20251_CNWeb_User_Management/7c0829f097849f9cfc54b5f6f37e2dbddda468c6/hoadaologo.jpg"
            },
            "description": "Xem bóng đá trực tiếp online miễn phí - Bun Cha TV",
            "share": {
                "url": "https://tt.8share.pro/buncha"
            },
            "notice": {
                "visible": False,
                "closeable": True,
                "icon": "https://media.hth4nh.eu.org/static/img/tele.png",
                "id": "notice",
                "link": "https://t.me/dqstore1",
                "text": "Nhóm Telegram cập nhật"
            },
            "option": {
                "save_history": False,
                "save_search_history": False,
                "save_wishlist": False
            }
        }

    # Transform matches into channels
    channels = []
    for idx, match in enumerate(matches_data.get("matches", [])):
        match_id = generate_id(match.get("link", str(idx)))
        match_name = match.get("text", "Match")
        
        # Build team names for display
        home_team = match.get("home", {})
        away_team = match.get("away", {})
        home_name_display = home_team.get("name") if isinstance(home_team, dict) else (home_team or "")
        away_name_display = away_team.get("name") if isinstance(away_team, dict) else (away_team or "")
        
        # Build channel object with new structure
        channel = {
            "id": match_id,
            "name": f"{home_name_display} vs {away_name_display}" if home_name_display and away_name_display else match_name,
            "labels": [
                {
                    "position": "top-left",
                    "text": "● Live",
                    "color": "#FF0000",
                    "text_color": "#FFFFFF",
                    "font_size": 6
                }
            ],
            "image": {
                "url": template_base["image"]["url"],
                "height": 480,
                "width": 640,
                "display": "cover"
            },
            "type": "single",
            "display": "overlay",
            "sources": []
        }
        
        # Build sources from streams
        streams = match.get("streams", [])
        if streams and len(streams) > 0:
            source_id = generate_id(f"{match_id}-source")
            source_name = f"{home_name_display} - {away_name_display}" if home_name_display and away_name_display else "Bun Cha TV"
            
            # Filter out error streams and build stream links
            valid_streams = [s for s in streams if s.get("url") and s.get("protocol") != "none"]
            
            if valid_streams:
                stream_links = []
                for stream_idx, stream in enumerate(valid_streams):
                    stream_link = {
                        "id": generate_id(f"{source_id}-link-{stream_idx}"),
                        "name": stream.get("label", f"Link {stream_idx + 1}"),
                        "type": stream.get("protocol", "hls"),
                        "default": stream_idx == 0,
                        "url": stream.get("url"),
                        "request_headers": [
                            {
                                "key": "Referer",
                                "value": match.get("link", "")
                            },
                            {
                                "key": "User-Agent",
                                "value": "Mozilla/5.0"
                            }
                        ]
                    }
                    stream_links.append(stream_link)
                
                if stream_links:
                    stream_obj = {
                        "id": generate_id(f"{source_id}-stream"),
                        "name": "Stream",
                        "stream_links": stream_links
                    }
                    
                    content_obj = {
                        "id": generate_id(f"{source_id}-content"),
                        "name": match_name,
                        "streams": [stream_obj]
                    }
                    
                    source_obj = {
                        "id": source_id,
                        "name": source_name,
                        "contents": [content_obj]
                    }
                    
                    channel["sources"].append(source_obj)
        
        channels.append(channel)
    
    # Build the final template
    output = {
        **template_base,
        "groups": [
            {
                "id": "live",
                "name": "⚽ Bóng đá",
                "display": "vertical",
                "grid_number": 2,
                "enable_detail": True,
                "channels": channels
            }
        ]
    }
    
    return output


def main():
    logger.info("=" * 60)
    logger.info("Starting Bun Cha TV match crawler")
    logger.info("=" * 60)
    
    # Extract hot matches with streams
    matches_data = extract_hot_matches(URL)
    
    logger.info(f"Transform {len(matches_data['matches'])} matches to template format")
    # Transform into template-compatible format
    template_output = transform_matches_to_template(matches_data)
    
    # Write to file
    out_file = "matches_streams.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(template_output, f, ensure_ascii=False, indent=2)

    logger.info(f"✓ Successfully wrote output to {out_file}")
    logger.info(f"✓ Total channels: {len(template_output['groups'][0]['channels'])}")
    logger.info("=" * 60)
    print(f"\n✓ Crawl completed! Output saved to: {out_file}")
    print(f"✓ Total channels extracted: {len(template_output['groups'][0]['channels'])}")


if __name__ == "__main__":
    main()