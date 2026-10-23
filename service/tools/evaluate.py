"""Evaluate local labelled crops without mixing map and UI-reference results.

This measures exact code counts, not point-in-plot or screen-click accuracy.
Labels awaiting user review remain explicitly marked in the output.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
import json
from pathlib import Path
import time

from service.ocr import OcrEngine, extract_codes


def score_codes(expected: list[str], detections: list[dict]) -> dict:
    truth = Counter(expected)
    predicted = Counter(item["code"] for item in detections)
    matched = truth & predicted
    correct = sum(matched.values())
    total = sum(predicted.values())
    return {"expectedCount": len(expected), "predictionCount": total,
            "correctCount": correct,
            "codeRecall": correct / len(expected) if expected else None,
            "codePrecision": correct / total if total else None,
            "matchedCodes": sorted(matched.elements()),
            "missingCodes": sorted((truth - matched).elements()),
            "extraCodes": sorted((predicted - matched).elements())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--out", type=Path, default=Path("tmp/labelled-crop-evaluation.json"))
    args = parser.parse_args()
    manifest_path = args.manifest.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    samples = manifest.get("samples", [])
    if not isinstance(samples, list) or not samples:
        parser.error("manifest needs a nonempty samples list")
    allowed_options = {"profile", "angles", "scale", "minConfidence"}
    prepared = []
    ids = set()
    for sample in samples:
        sample_id = sample.get("id")
        expected = sample.get("expectedCodes")
        options = sample.get("ocrOptions", {})
        if not isinstance(sample_id, str) or not sample_id or sample_id in ids:
            parser.error("sample ids must be nonempty and unique")
        ids.add(sample_id)
        if (not isinstance(expected, list) or not expected
                or any(not isinstance(code, str) or extract_codes(code) != [code] for code in expected)):
            parser.error(f"{sample_id}: expectedCodes must contain complete normalized codes")
        if not isinstance(options, dict) or set(options) - allowed_options:
            parser.error(f"{sample_id}: unsupported OCR options")
        image_path = (manifest_path.parent / sample["image"]).resolve()
        if args.out.resolve() in {manifest_path, image_path}:
            parser.error("report must not overwrite an input")
        prepared.append((sample, image_path))
    engine = OcrEngine()
    report = {"manifest": str(manifest_path), "languages": engine.health()["languages"],
              "recognitionModel": engine.health()["recognitionModel"], "samples": [],
              "limitation": "Code counts only; no plot polygons, point accuracy or click validation. "
                            "Pending labels need user confirmation; no weight training is performed."}
    for index, (sample, image_path) in enumerate(prepared):
        # Use the same bounded decoding contract as the OCR service.
        if image_path.stat().st_size > 12 * 1024 * 1024:
            parser.error("evaluate cropped images under 12 MiB, not a large source map")
        image_bytes = image_path.read_bytes()
        mime = "jpeg" if image_path.suffix.lower() in {".jpg", ".jpeg"} else "png"
        payload = {**sample.get("ocrOptions", {}),
                   "image": f"data:image/{mime};base64," + base64.b64encode(image_bytes).decode("ascii")}
        started = time.perf_counter()
        result = engine.recognize(payload)
        item = {"id": sample["id"], "role": sample.get("role", "map"),
                "reviewStatus": sample.get("reviewStatus", "pending-user"),
                "coldModel": index == 0, "seconds": round(time.perf_counter() - started, 3),
                "ocrOptions": sample.get("ocrOptions", {}),
                **score_codes(sample["expectedCodes"], result["detections"]), "result": result}
        report["samples"].append(item)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({key: item[key] for key in
              ("id", "role", "reviewStatus", "correctCount", "expectedCount", "extraCodes", "seconds")}), flush=True)


if __name__ == "__main__":
    main()
