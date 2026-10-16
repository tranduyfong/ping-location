"""Conservative code extraction and OCR in original screenshot coordinates."""
from __future__ import annotations

import base64
import binascii
import importlib.util
import io
import math
import os
from pathlib import Path
import re
import threading
import time
import unicodedata
import warnings

MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_IMAGE_DIMENSION = 8192
MAX_WORK_PIXELS = 16_000_000
DEFAULT_ANGLES = (0, 30, 60, 90, 120, 150)
REQUIRED_MODELS = ("craft_mlt_25k.pth", "english_g2.pth")
DASHES = str.maketrans({c: "-" for c in "‐‑‒–—−﹣－"})
CODE_PATTERN = re.compile(r"(?<![A-Z0-9.\-])([A-Z][A-Z0-9]*(?:\.[A-Z0-9]+)*\s*-\s*[0-9]{1,6})(?![A-Z0-9.\-])")


class InputError(ValueError):
    pass


class OcrUnavailable(RuntimeError):
    pass


class OcrCancelled(RuntimeError):
    pass


def extract_codes(raw: str) -> list[str]:
    """Normalize explicit codes only. Never guess missing text or O/0 errors."""
    text = unicodedata.normalize("NFKC", raw).translate(DASHES).upper()
    text = re.sub(r"\s*\.\s*", ".", text)
    return list(dict.fromkeys(re.sub(r"\s+", "", m.group(1)) for m in CODE_PATTERN.finditer(text)))


def validate_parameters(payload: dict) -> tuple[list[float], float, float]:
    if not isinstance(payload, dict):
        raise InputError("JSON body must be an object")
    angles = payload.get("angles", list(DEFAULT_ANGLES))
    if not isinstance(angles, list) or not 1 <= len(angles) <= 12:
        raise InputError("angles must contain 1 to 12 finite numbers")
    normalized = []
    for angle in angles:
        if (not isinstance(angle, (int, float)) or isinstance(angle, bool)
                or not math.isfinite(angle) or abs(angle) > 360):
            raise InputError("angles must be finite numbers between -360 and 360")
        value = float(angle) % 360
        if value not in normalized:
            normalized.append(value)
    confidence = payload.get("minConfidence", 0.3)
    profile = payload.get("profile", "quick")
    if not isinstance(profile, str) or profile not in {"quick", "thorough"}:
        raise InputError("profile must be quick or thorough")
    scale = payload.get("scale", 1 if profile == "quick" else 2)
    for key, value, low, high in (("minConfidence", confidence, 0, 1), ("scale", scale, 1, 3)):
        if (not isinstance(value, (int, float)) or isinstance(value, bool)
                or not math.isfinite(value) or not low <= value <= high):
            raise InputError(f"{key} must be a finite number between {low} and {high}")
    return normalized, float(confidence), float(scale)


def decode_image(data_url: object):
    from PIL import Image, UnidentifiedImageError

    if not isinstance(data_url, str):
        raise InputError("image must be a PNG or JPEG data URL")
    match = re.fullmatch(r"data:image/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)", data_url)
    if not match or len(match.group(2)) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise InputError("image must be a PNG or JPEG data URL under 12 MiB")
    try:
        image_bytes = base64.b64decode(match.group(2), validate=True)
        if len(image_bytes) > MAX_IMAGE_BYTES:
            raise InputError("decoded image exceeds 12 MiB")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(image_bytes))
            width, height = image.size
            if (image.format not in {"PNG", "JPEG"} or width < 1 or height < 1
                    or max(width, height) > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS):
                raise InputError("image must be PNG/JPEG, at most 8192 px per side and 20 megapixels")
            image.load()
            return image.convert("RGB")
    except InputError:
        raise
    except (binascii.Error, ValueError, OSError, UnidentifiedImageError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise InputError("invalid or unsafe image") from exc


def rotation_transform(width: int, height: int, angle: float):
    """Affine source-to-expanded-canvas matrix for a visual CCW rotation."""
    import numpy as np

    a = round(math.cos(math.radians(angle)), 12)
    b = round(math.sin(math.radians(angle)), 12)
    matrix = np.array([[a, b, 0.0], [-b, a, 0.0]], dtype=np.float64)
    corners = np.array([[0, 0], [width, 0], [width, height], [0, height]], dtype=np.float64)
    mapped = corners @ matrix[:, :2].T
    low, high = mapped.min(axis=0), mapped.max(axis=0)
    matrix[:, 2] = -low
    size = tuple(max(1, math.ceil(float(value) - 1e-8)) for value in high - low)
    return matrix, size


def inverse_points(points, matrix, scale_x: float, scale_y: float) -> list[list[float]]:
    import numpy as np

    points = np.asarray(points, dtype=np.float64)
    original = (points - matrix[:, 2]) @ np.linalg.inv(matrix[:, :2]).T
    original[:, 0] /= scale_x
    original[:, 1] /= scale_y
    return original.tolist()


def adaptive_angles(image) -> list[float]:
    """Estimate text direction from colored ink geometry, never from unit codes.

    Hue is used only for a cheap orientation hint; OCR always sees the original
    color image and can still read black or differently colored labels.
    """
    import cv2
    import numpy as np
    rgb = np.asarray(image)
    r, g, b = [rgb[:, :, index].astype(np.int16) for index in range(3)]
    mask = ((b - np.maximum(r, g) > 65) & (r < 155) & (g < 155) & (b > 70)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    votes = []
    for contour in contours:
        if not 10 < cv2.contourArea(contour) < 1200:
            continue
        _, (width, height), angle = cv2.minAreaRect(contour)
        if min(width, height) < 2 or max(width, height) > 150 or max(width, height) / min(width, height) < 1.8:
            continue
        if width < height:
            angle += 90
        votes.append(((angle + 90) % 180) - 90)
    if len(votes) < 6:
        return [0.0, 90.0]
    def distance(a, b):
        return abs(((a - b + 90) % 180) - 90)
    candidates = list(range(-90, 90, 5))
    ranked = sorted(candidates, key=lambda candidate: sum(max(0, 1 - distance(candidate, vote) / 12) for vote in votes), reverse=True)
    first = ranked[0]
    remaining = [candidate for candidate in ranked if distance(candidate, first) >= 35]
    selected = [first]
    if remaining and sum(distance(remaining[0], vote) <= 12 for vote in votes) >= 4:
        selected.append(remaining[0])
    return [float(angle % 360) for angle in selected]


def image_tiles(width: int, height: int, size: int = 900, overlap: int = 100):
    def starts(dimension):
        if dimension <= size:
            return [0]
        return sorted(set([*range(0, dimension - size, size - overlap), dimension - size]))
    return [(x, y, min(width, x + size), min(height, y + size))
            for y in starts(height) for x in starts(width)]


def read_bounded(reader, bgr, canvas_size, check_cancel, on_batch):
    """Use EasyOCR's public detect/recognize API in similar-width groups.

    Its normal readtext(rotation_info=[180]) pads *every* word to the widest
    street-name crop in the entire image. Hundreds of tiny labels then cost
    as much as that street name. Width groups prevent that CPU/memory blowup.
    """
    import cv2
    if not hasattr(reader, "detect") or not hasattr(reader, "recognize"):
        return reader.readtext(bgr, detail=1, paragraph=False, batch_size=4, workers=0,
            min_size=5, text_threshold=0.6, low_text=0.3, rotation_info=[180],
            canvas_size=canvas_size, mag_ratio=1.0, width_ths=0.35)
    horizontal, free = reader.detect(bgr, min_size=5, text_threshold=0.6, low_text=0.3,
                                    canvas_size=canvas_size, mag_ratio=1, width_ths=0.35)
    check_cancel()
    groups = {}
    for box in horizontal[0]:
        left, right, top, bottom = map(float, box)
        width, height = right - left, bottom - top
        if width < 10 or height < 3 or not 1.2 <= width / height <= 20:
            continue
        bucket = math.ceil((width / height * 64) / 32) * 32
        groups.setdefault(bucket, {"horizontal": [], "free": []})["horizontal"].append(box)
    for box in free[0]:
        xs, ys = zip(*box)
        width, height = max(xs) - min(xs), max(ys) - min(ys)
        if width < 10 or height < 3 or not 1.2 <= width / height <= 20:
            continue
        bucket = math.ceil((width / height * 64) / 32) * 32
        groups.setdefault(bucket, {"horizontal": [], "free": []})["free"].append(box)
    grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    batches = []
    for _, group in sorted(groups.items()):
        for kind in ("horizontal", "free"):
            for start in range(0, len(group[kind]), 48):
                batches.append((kind, group[kind][start:start + 48]))
    results = []
    for index, (kind, boxes) in enumerate(batches):
        check_cancel()
        on_batch(index, len(batches), len(results))
        results.extend(reader.recognize(grey, horizontal_list=boxes if kind == "horizontal" else [],
            free_list=boxes if kind == "free" else [], decoder="greedy", batch_size=16, workers=0,
            detail=1, paragraph=False, rotation_info=[180], reformat=False))
    return results


def find_model_directory(explicit: str | Path | None = None) -> Path:
    project = Path(__file__).resolve().parents[1]
    configured = explicit or os.environ.get("PING_LOCATION_MODEL_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    candidates = [project / ".models" / "easyocr", project / ".models",
                  project.parent / "plan-sync-review" / "output" / "models" / "easyocr",
                  project.parent / "plan-sync-review" / ".models" / "easyocr",
                  project.parent / "plan-sync-review" / ".models"]
    for variable in ("EASYOCR_MODULE_PATH", "MODULE_PATH"):
        if os.environ.get(variable):
            candidates.append(Path(os.environ[variable]) / "model")
    candidates.append(Path.home() / ".EasyOCR" / "model")
    for directory in candidates:
        if all((directory / filename).is_file() for filename in REQUIRED_MODELS):
            return directory.resolve()
    return candidates[0]


class OcrEngine:
    def __init__(self, model_directory: str | Path | None = None, data_directory: Path | None = None):
        self.model_directory = find_model_directory(model_directory)
        self.data_directory = data_directory or Path(__file__).resolve().parent / ".data"
        self._reader = None
        self._load_error = None
        self._lock = threading.Lock()
        self._last_metrics = None

    def health(self) -> dict:
        dependencies = {name: importlib.util.find_spec(name) is not None
                        for name in ("easyocr", "PIL", "numpy", "cv2")}
        missing = [name for name in REQUIRED_MODELS if not (self.model_directory / name).is_file()]
        return {"ok": True, "service": "ping-location-ocr", "version": 2,
                "ocrReady": not missing and all(dependencies.values()) and not self._load_error,
                "modelsAvailable": not missing, "dependencies": dependencies,
                "modelDirectory": str(self.model_directory), "missingModels": missing,
                "loaded": self._reader is not None, "loadError": self._load_error,
                "downloadEnabled": False, "workerWarm": self._reader is not None,
                "busy": self._lock.locked(), "lastScan": self._last_metrics}

    def _get_reader(self, download: bool = False):
        if self._reader is not None:
            return self._reader
        if not download and not self.health()["ocrReady"]:
            raise OcrUnavailable("OCR dependencies or local models are unavailable; see GET /health")
        try:
            import easyocr
            import torch

            torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
            user_directory = self.data_directory / "user-network"
            user_directory.mkdir(parents=True, exist_ok=True)
            self._reader = easyocr.Reader(
                ["en"], gpu=False, model_storage_directory=str(self.model_directory),
                user_network_directory=str(user_directory), download_enabled=download, verbose=False)
            self._load_error = None
            return self._reader
        except Exception as exc:
            self._load_error = f"{type(exc).__name__}: {exc}"
            raise OcrUnavailable("Could not load local OCR model; inspect GET /health") from exc

    def download_models(self):
        with self._lock:
            self.model_directory.mkdir(parents=True, exist_ok=True)
            self._get_reader(download=True)

    def recognize(self, payload: dict, progress=None, cancel_event=None) -> dict:
        angles, threshold, requested_scale = validate_parameters(payload)
        try:
            image = decode_image(payload.get("image"))
        except ImportError as exc:
            raise OcrUnavailable("Pillow is not installed; install service/requirements.txt") from exc
        # One OCR job at a time: browsers receive a retryable 429 instead of
        # silently building an unbounded queue of screenshots in memory.
        if not self._lock.acquire(blocking=False):
            image.close()
            raise BlockingIOError("OCR is busy; retry after the current scan")
        try:
            return self._recognize_image(image, angles, threshold, requested_scale,
                    profile=payload.get("profile", "quick"), adaptive="angles" not in payload,
                    progress=progress, cancel_event=cancel_event)
        finally:
            image.close()
            self._lock.release()

    def _recognize_image(self, image, angles, threshold, requested_scale, *, profile="quick", adaptive=False,
                         progress=None, cancel_event=None):
        started = time.perf_counter()
        def check_cancel():
            if cancel_event is not None and cancel_event.is_set():
                raise OcrCancelled("OCR scan was cancelled")
        def report(stage, completed, total, message, **extra):
            if progress:
                progress({"stage": stage, "completed": completed, "total": total, "message": message, **extra})
        check_cancel()
        report("loading-model", 0, 1, "Loading local OCR model" if self._reader is None else "OCR model is warm")
        reader = self._get_reader()
        import cv2
        import numpy as np

        width, height = image.size
        check_cancel()
        if adaptive:
            angles = adaptive_angles(image)
            if profile == "quick":
                angles = angles[:1]
        tiles = image_tiles(width, height) if profile == "thorough" else [(0, 0, width, height)]
        total = len(tiles) * len(angles)
        detections = []
        notices = []
        if adaptive:
            notices.append("Text orientation was estimated automatically; use explicit angles or thorough scanning if labels are missed.")
        if profile == "quick":
            notices.append("Quick scan limits image processing size; zoom the live map for small labels or use thorough scanning.")
        completed = 0
        for left, top, right, bottom in tiles:
          check_cancel()
          tile_width, tile_height = right - left, bottom - top
          # Bounding both source pixels and detector canvas avoids the former
          # six giant 2x full-screen passes. Thorough mode uses overlapping
          # tiles so cancellation can be observed between bounded calls.
          budget = 6_000_000 if profile == "quick" else MAX_WORK_PIXELS
          scale_limit = math.sqrt(budget / (2 * tile_width * tile_height))
          if profile == "quick":
              scale_limit = min(scale_limit, 2000 / max(tile_width, tile_height))
          scale = min(requested_scale, scale_limit)
          scaled_width, scaled_height = max(1, round(tile_width * scale)), max(1, round(tile_height * scale))
          scale_x, scale_y = scaled_width / tile_width, scaled_height / tile_height
          rgb = np.asarray(image)[top:bottom, left:right]
          if (scaled_width, scaled_height) != (tile_width, tile_height):
              rgb = cv2.resize(rgb, (scaled_width, scaled_height), interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
          if scale < requested_scale - 0.001 and not any("scaling" in notice for notice in notices):
              notices.append("Image scaling was limited by the OCR processing budget.")
          for angle in angles:
            check_cancel()
            report("recognizing", completed, total, f"Reading tile {tiles.index((left, top, right, bottom)) + 1}/{len(tiles)}, angle {angle:g}",
                   found=len(detections), angle=angle)
            matrix, size = rotation_transform(scaled_width, scaled_height, angle)
            canvas = rgb if angle == 0 else cv2.warpAffine(rgb, matrix, size,
                       flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message=".*pin_memory.*", category=UserWarning)
                # EasyOCR's ndarray input contract is BGR (its reformat_input
                # uses COLOR_BGR2GRAY); Pillow supplies RGB.
                def batch_progress(index, batches, recognized):
                    report("recognizing-text", completed, total,
                           f"Reading text group {index + 1}/{batches} in pass {completed + 1}/{total}",
                           found=len(detections), batch=index + 1, batches=batches, angle=angle)
                results = read_bounded(reader, cv2.cvtColor(canvas, cv2.COLOR_RGB2BGR),
                                       1280 if profile == "quick" else 2400, check_cancel, batch_progress)
            check_cancel()
            for box, raw, confidence in results:
                if not math.isfinite(float(confidence)) or float(confidence) < threshold:
                    continue
                codes = extract_codes(str(raw))
                # A box that contains two units does not identify a safe point.
                if len(codes) != 1 or np.asarray(box).shape != (4, 2):
                    continue
                original = inverse_points(box, matrix, scale_x, scale_y)
                original = [[x + left, y + top] for x, y in original]
                if not all(math.isfinite(v) for point in original for v in point):
                    continue
                center_x = sum(point[0] for point in original) / 4
                center_y = sum(point[1] for point in original) / 4
                if not 0 <= center_x < width or not 0 <= center_y < height:
                    continue
                bounded = [[round(max(0, min(width - 1, x)), 3), round(max(0, min(height - 1, y)), 3)]
                           for x, y in original]
                detections.append({"code": codes[0], "raw": str(raw), "confidence": round(float(confidence), 6),
                    "x": round(center_x, 3), "y": round(center_y, 3), "box": bounded, "angle": angle})
            completed += 1
            report("recognizing", completed, total, f"Finished {completed}/{total} passes", found=len(detections))
        unique = []
        for detection in sorted(detections, key=lambda item: item["confidence"], reverse=True):
            if any(old["code"] == detection["code"] and math.hypot(old["x"] - detection["x"], old["y"] - detection["y"]) <= 16
                   for old in unique):
                continue
            unique.append(detection)
        self._last_metrics = {"seconds": round(time.perf_counter() - started, 3), "profile": profile,
                              "angles": angles, "tiles": len(tiles), "detections": len(unique)}
        report("completed", total, total, f"Found {len(unique)} unit labels", found=len(unique))
        return {"width": width, "height": height, "detections": unique, "warnings": notices,
                "metrics": self._last_metrics}
