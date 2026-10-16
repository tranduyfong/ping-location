"""Read only public page bundles to inspect the available DOM integration."""
import concurrent.futures
import html
import json
import re
from pathlib import Path
from urllib.request import Request, urlopen

BASE = "https://vhub.com.vn"
ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / "page-public.html").read_text(encoding="utf-8")
paths = re.findall(r'<script[^>]+src="([^"]+)"', source)
destination = ROOT / "tmp" / "public-bundles"
destination.mkdir(parents=True, exist_ok=True)

def inspect(path):
    url = BASE + html.unescape(path)
    with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=25) as response:
        text = response.read(6_000_000).decode("utf-8", "replace")
    terms = [word for word in ["Quản lý hotspot", "Chờ gắn", "scene_mb_quy_can", "krpanoSWFObject", "hotspot-manager", "tour_driver"] if word in text]
    if terms:
        name = path.rsplit("/", 1)[-1].split("?", 1)[0]
        (destination / name).write_text(text, encoding="utf-8")
        return {"bundle": name, "size": len(text), "terms": terms}
    return None

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    for result in pool.map(inspect, paths):
        if result:
            print(json.dumps(result, ensure_ascii=True))
