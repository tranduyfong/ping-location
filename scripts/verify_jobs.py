"""Exercise the running OCR service with readable synthetic labels; no image files."""
import base64
import io
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen

from PIL import Image, ImageDraw, ImageFont

BASE = "http://127.0.0.1:8766"


def request(path, body=None, method=None):
    payload = None if body is None else json.dumps(body).encode()
    req = Request(BASE + path, payload, {"Content-Type": "application/json"}, method=method)
    with urlopen(req, timeout=10) as response:
        return json.load(response)


def main():
    health = request("/health")
    assert health.get("jobsApi") == 1 and health["ocrReady"], health
    image = Image.new("RGB", (800, 300), "#f4f2e7")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 40)
    draw.rectangle((30, 30, 750, 130), fill="#c3bee4")
    draw.rectangle((30, 150, 750, 260), fill="#e9df86")
    draw.text((90, 55), "VN48-123", font=font, fill="#263674")
    draw.text((90, 180), "VX-002", font=font, fill="#263674")
    encoded = io.BytesIO()
    image.save(encoded, "PNG")
    payload = {"image": "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode(),
               "angles": [0], "minConfidence": 0.3}
    started = time.monotonic()
    job = request("/jobs", payload)
    previous = None
    while job["state"] in {"queued", "running"}:
        phase = job["progress"]["stage"]
        if phase != previous:
            print(json.dumps({"phase": phase, "seconds": round(time.monotonic() - started, 2)}), flush=True)
            previous = phase
        if time.monotonic() - started > 100:
            request("/jobs/" + job["jobId"], method="DELETE")
            raise TimeoutError("OCR smoke exceeded 100 seconds and was cancelled")
        time.sleep(0.5)
        job = request("/jobs/" + job["jobId"])
    assert job["state"] == "completed", job
    codes = sorted({d["code"] for d in job["result"]["detections"]})
    assert "VN48-123" in codes and "VX-002" in codes, codes
    reused = request("/jobs", payload)
    assert reused["cached"] and reused["jobId"] == job["jobId"], reused
    report = {"serviceVersion": health["version"], "elapsedSeconds": round(time.monotonic() - started, 3),
              "codes": codes, "cacheReused": True, "jobId": job["jobId"],
              "scope": "Readable synthetic labels; not a benchmark of small map labels."}
    output = Path("tmp/verify-jobs.json")
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
