"""Evaluate an actual screenshot without saving image data.

The expected list is human-supplied ground truth, never an OCR repair rule.
"""
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
    parser.add_argument("--crop", nargs=4, type=int, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    parser.add_argument("--angles", nargs="+", type=float, default=[0, 30, 60, 90, 120, 150])
    parser.add_argument("--scale", type=float, default=3)
    parser.add_argument("--min-confidence", type=float, default=0.3)
    parser.add_argument("--expected", nargs="*", default=[])
    parser.add_argument("--out", type=Path, default=Path("tmp/ocr-smoke-report.json"))
    args = parser.parse_args()
    image = Image.open(args.image).convert("RGB")
    source_size = image.size
    if args.crop:
        left, top, right, bottom = args.crop
        if not (0 <= left < right <= image.width and 0 <= top < bottom <= image.height):
            parser.error("crop must stay inside the image")
        image = image.crop(tuple(args.crop))
    output = io.BytesIO()
    image.save(output, "PNG")
    payload = {"image": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii"),
               "angles": args.angles, "scale": args.scale, "minConfidence": args.min_confidence}
    engine = OcrEngine()
    start = time.perf_counter()
    result = engine.recognize(payload)
    elapsed = time.perf_counter() - start
    expected = sorted(set(args.expected))
    found = sorted(set(detection["code"] for detection in result["detections"]))
    report = {"input": args.image.name, "sourceSize": list(source_size), "crop": args.crop,
              "angles": args.angles, "scale": args.scale, "minConfidence": args.min_confidence,
              "elapsedSecondsIncludingColdLoad": round(elapsed, 3),
              "modelDirectory": str(engine.model_directory), "downloadEnabled": False,
              "expectedCodes": expected, "detectedCodes": found,
              "verifiedExpectedCodes": sorted(set(found).intersection(expected)),
              "missingExpectedCodes": sorted(set(expected) - set(found)),
              "unexpectedCodes": sorted(set(found) - set(expected)),
              "verifiedCount": len(set(found).intersection(expected)),
              "expectedCount": len(expected), "result": result,
              "limitation": "A single screenshot crop smoke test is not a general accuracy estimate. "
                            "Small JPEG labels need a higher-resolution capture or human teaching."}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(args.out), "seconds": round(elapsed, 2), "detected": found,
                      "verified": report["verifiedCount"], "expected": len(expected)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
