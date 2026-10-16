"""Loopback-only JSON HTTP API; no images are written to disk."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import re
import socket
import threading
import time
from urllib.parse import urlsplit

from .ocr import InputError, OcrEngine, OcrUnavailable, extract_codes
from .jobs import JobManager, JobNotFound

MAX_BODY_BYTES = 18 * 1024 * 1024
MAX_FEEDBACK_BYTES = 8192
ALLOWED_ORIGIN = re.compile(r"(?:chrome-extension://[a-p]{32}|https?://(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?)\Z")


def allowed_origin(origin: str | None) -> bool:
    return origin is None or ALLOWED_ORIGIN.fullmatch(origin) is not None


def validate_feedback(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise InputError("feedback must be an object")
    if set(payload) - {"code", "raw", "x", "y", "kind", "context"}:
        raise InputError("feedback contains unsupported fields; images are never retained")
    for key, limit in (("code", 80), ("raw", 256), ("kind", 32)):
        value = payload.get(key, "" if key == "raw" else None)
        if not isinstance(value, str) or len(value) > limit or (key != "raw" and not value):
            raise InputError(f"{key} must be a short string")
    normalized = extract_codes(payload["code"])
    if len(normalized) != 1 or normalized[0] != payload["code"].strip().upper():
        raise InputError("code must be a complete explicit unit code, such as VX-002")
    result = {"code": normalized[0], "raw": payload.get("raw", ""), "kind": payload["kind"]}
    for key in ("x", "y"):
        value = payload.get(key)
        if (not isinstance(value, (int, float)) or isinstance(value, bool)
                or not math.isfinite(value) or not 0 <= value <= 8192):
            raise InputError(f"{key} must be a finite image coordinate from 0 to 8192")
        result[key] = value
    context = payload.get("context", {})
    try:
        encoded = json.dumps(context, ensure_ascii=False, allow_nan=False)
    except (ValueError, TypeError, RecursionError) as exc:
        raise InputError("context must contain finite JSON values") from exc
    if len(encoded.encode("utf-8")) > 4096:
        raise InputError("context exceeds 4096 bytes")

    def check_context(value, depth=0):
        if depth > 4:
            raise InputError("context is too deeply nested")
        if isinstance(value, dict):
            if len(value) > 24:
                raise InputError("context has too many fields")
            for key, item in value.items():
                if not isinstance(key, str) or len(key) > 80 or any(word in key.lower() for word in ("image", "screenshot", "dataurl")):
                    raise InputError("context cannot contain image fields")
                check_context(item, depth + 1)
        elif isinstance(value, list):
            if len(value) > 24:
                raise InputError("context has too many entries")
            for item in value:
                check_context(item, depth + 1)
        elif isinstance(value, str):
            if len(value) > 512 or re.search(r"data:|[A-Za-z0-9+/]{256,}={0,2}", value, re.I):
                raise InputError("context cannot contain images or long encoded data")
        elif value is not None and not isinstance(value, (int, float, bool)):
            raise InputError("context must contain JSON values")

    check_context(context)
    result["context"] = context
    # Apply the same retention rule to every user string, including raw/kind.
    for value in (result["code"], result["raw"], result["kind"]):
        if re.search(r"data:|[A-Za-z0-9+/]{256,}={0,2}", value, re.I):
            raise InputError("feedback cannot contain images or encoded data")
    result["createdAt"] = datetime.now(timezone.utc).isoformat()
    return result


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, engine: OcrEngine, feedback_path: Path):
        super().__init__(address, Handler)
        self.engine = engine
        self.feedback_path = feedback_path
        self.feedback_lock = threading.Lock()
        self.jobs = JobManager(engine)

    def server_close(self):
        self.jobs.close()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PingLocation/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(20)
        self._body_read = False

    def log_message(self, format, *args):
        # Request bodies and screenshot data never enter logs.
        return

    def _access_allowed(self):
        if not allowed_origin(self.headers.get("Origin")):
            self._send(403, {"error": "origin_not_allowed"})
            return False
        expected_port = self.server.server_address[1]
        if self.headers.get("Host") not in {f"127.0.0.1:{expected_port}", f"localhost:{expected_port}"}:
            self._send(403, {"error": "host_not_allowed"})
            return False
        return True

    def _discard_rejected_small_body(self):
        # Closing a Windows socket with an unread POST body can send a reset
        # that hides our HTTP error from the client. Drain only a declared,
        # bounded small body; never wait for or read an oversized upload.
        if self.command != "POST" or self._body_read or self.headers.get("Transfer-Encoding"):
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            return
        if not 0 <= length <= MAX_FEEDBACK_BYTES:
            return
        old_timeout = self.connection.gettimeout()
        try:
            self.connection.settimeout(0.25)
            self.rfile.read(length)
            self._body_read = True
        except (OSError, TimeoutError):
            pass
        finally:
            self.connection.settimeout(old_timeout)

    def _send(self, status: int, body: dict):
        if status >= 400:
            self._discard_rejected_small_body()
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin")
        if origin and allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)
        self.wfile.flush()
        # Queue the complete response and FIN before the server closes the
        # socket. A 413 never reads or allocates the declared large body.
        try:
            self.connection.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        if status >= 400 and self.command == "POST" and not self._body_read:
            # A client may already have sent a prefix despite a rejected size
            # declaration. Discard only a fixed 8 KiB prefix, after delivering
            # the error, to avoid Windows replacing that response with RST.
            # The cap and deadline are independent of Content-Length.
            deadline = time.monotonic() + 0.1
            remaining = MAX_FEEDBACK_BYTES
            old_timeout = self.connection.gettimeout()
            try:
                while remaining and time.monotonic() < deadline:
                    self.connection.settimeout(max(0.001, deadline - time.monotonic()))
                    discarded = self.rfile.read1(remaining)
                    if not discarded:
                        break
                    remaining -= len(discarded)
            except (OSError, TimeoutError):
                pass
            finally:
                self.connection.settimeout(old_timeout)
        self.close_connection = True

    def do_OPTIONS(self):
        if not self._access_allowed():
            return
        if urlsplit(self.path).path not in {"/health", "/ocr", "/feedback", "/jobs"} and not re.fullmatch(r"/jobs/[0-9a-f]{32}", self.path):
            self._send(404, {"error": "not_found"})
            return
        self.send_response(204)
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def do_GET(self):
        if not self._access_allowed():
            return
        if self.path == "/health":
            self._send(200, {**self.server.engine.health(), **self.server.jobs.health()})
        elif re.fullmatch(r"/jobs/[0-9a-f]{32}", self.path):
            try:
                self._send(200, self.server.jobs.get(self.path.rsplit("/", 1)[1]))
            except JobNotFound:
                self._send(404, {"error": "job_not_found"})
        else:
            self._send(404, {"error": "not_found"})

    def do_DELETE(self):
        if not self._access_allowed():
            return
        if not re.fullmatch(r"/jobs/[0-9a-f]{32}", self.path):
            self._send(404, {"error": "not_found"})
            return
        try:
            self._send(202, self.server.jobs.cancel(self.path.rsplit("/", 1)[1]))
        except JobNotFound:
            self._send(404, {"error": "job_not_found"})

    def _read_json(self, maximum):
        if self.headers.get("Transfer-Encoding"):
            self._send(400, {"error": "transfer_encoding_not_supported"})
            return None
        if self.headers.get_content_type() != "application/json":
            self._send(415, {"error": "content_type_must_be_json"})
            return None
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0:
            self._send(411, {"error": "content_length_required"})
            return None
        if length > maximum:
            self._send(413, {"error": "request_too_large", "maxBytes": maximum})
            return None
        try:
            self._body_read = True
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("incomplete body")
            def reject_constant(value):
                raise ValueError(f"invalid JSON constant: {value}")
            payload = json.loads(body.decode("utf-8"), parse_constant=reject_constant)
            if not isinstance(payload, dict):
                raise ValueError("JSON must be an object")
            return payload
        except (UnicodeDecodeError, ValueError, RecursionError):
            self._send(400, {"error": "invalid_json"})
            return None

    def do_POST(self):
        if not self._access_allowed():
            return
        if self.path not in {"/ocr", "/feedback", "/jobs"}:
            self._send(404, {"error": "not_found"})
            return
        payload = self._read_json(MAX_FEEDBACK_BYTES if self.path == "/feedback" else MAX_BODY_BYTES)
        if payload is None:
            return
        try:
            if self.path == "/jobs":
                self._send(202, self.server.jobs.submit(payload))
                return
            elif self.path == "/ocr":
                if self.server.jobs.health()["activeJob"] is not None:
                    raise BlockingIOError("An asynchronous OCR scan is already running")
                result = self.server.engine.recognize(payload)
            else:
                record = validate_feedback(payload)
                with self.server.feedback_lock:
                    self.server.feedback_path.parent.mkdir(parents=True, exist_ok=True)
                    with self.server.feedback_path.open("a", encoding="utf-8") as output:
                        output.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
                result = {"ok": True, "saved": True, "trainingApplied": False}
            self._send(200, result)
        except InputError as exc:
            self._send(400, {"error": "invalid_request", "message": str(exc)})
        except BlockingIOError as exc:
            self._send(429, {"error": "ocr_busy", "message": str(exc)})
        except OcrUnavailable as exc:
            self._send(503, {"error": "ocr_unavailable", "message": str(exc)})
        except Exception as exc:
            print(f"Request failed: {type(exc).__name__}", flush=True)
            self._send(500, {"error": "service_error", "message": "Local service failed; check the service terminal"})


def main():
    parser = argparse.ArgumentParser(description="Ping Location OCR, local CPU only")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--model-dir", help="Directory containing craft_mlt_25k.pth and english_g2.pth")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parent / ".data")
    parser.add_argument("--download-models", action="store_true", help="Explicitly download OCR weights, then exit")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be 1..65535")
    engine = OcrEngine(args.model_dir, args.data_dir.resolve())
    if args.download_models:
        # Downloads always default to this project, not a neighboring project.
        if not args.model_dir:
            engine.model_directory = Path(__file__).resolve().parents[1] / ".models" / "easyocr"
        print(f"Downloading OCR models to {engine.model_directory}", flush=True)
        engine.download_models()
        print("Models are ready. Restart without --download-models.", flush=True)
        return
    with LocalServer(("127.0.0.1", args.port), engine, args.data_dir.resolve() / "feedback.jsonl") as server:
        print(f"Ping Location OCR: http://127.0.0.1:{args.port} (Ctrl+C to stop)", flush=True)
        print(f"Local models: {engine.model_directory}; automatic downloads disabled", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.", flush=True)


if __name__ == "__main__":
    main()
