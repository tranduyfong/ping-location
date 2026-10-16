"""Reproduce quick OCR timing on a full screenshot and optional warm ROI."""
import argparse
import base64
import io
import json
from pathlib import Path
import time

from PIL import Image

from service.ocr import OcrEngine


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--roi", type=int, nargs=4, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    parser.add_argument("--out", type=Path, default=Path("tmp/ocr-quick-benchmark.json"))
    args = parser.parse_args()
    source = Image.open(args.image).convert("RGB")
    cases = [("full", source)]
    if args.roi:
        left, top, right, bottom = args.roi
        if not 0 <= left < right <= source.width or not 0 <= top < bottom <= source.height:
            parser.error("ROI must stay inside the screenshot")
        cases.append(("roi", source.crop(tuple(args.roi))))
    engine = OcrEngine()
    reports = []
    for index, (name, image) in enumerate(cases):
        output = io.BytesIO()
        image.save(output, "PNG")
        payload = {"image": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii"),
                   "minConfidence": 0.25}
        started = time.perf_counter()
        def progress(value):
            print(json.dumps({"case": name, "elapsed": round(time.perf_counter() - started, 2), **value}), flush=True)
        result = engine.recognize(payload, progress=progress)
        report = {"case": name, "imageSize": list(image.size), "roi": args.roi if name == "roi" else None,
                  "seconds": round(time.perf_counter() - started, 3), "coldModel": index == 0,
                  "detections": result["detections"], "warnings": result["warnings"], "metrics": result["metrics"]}
        reports.append(report)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"case": name, "seconds": report["seconds"], "codes": [item["code"] for item in result["detections"]]}), flush=True)


if __name__ == "__main__":
    main()
