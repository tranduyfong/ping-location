"""One active local OCR worker, cooperative cancellation, bounded result cache."""
from __future__ import annotations

from collections import OrderedDict
import hashlib
import json
import threading
import time
import uuid

from .ocr import InputError, OcrCancelled, OcrUnavailable, decode_image, validate_parameters


class JobNotFound(KeyError):
    pass


class JobManager:
    def __init__(self, engine, *, ttl_seconds=600, max_jobs=8, max_result_bytes=64 * 1024 * 1024, clock=time.monotonic):
        self.engine = engine
        self.ttl_seconds = ttl_seconds
        self.max_jobs = max_jobs
        self.max_result_bytes = max_result_bytes
        self.clock = clock
        self._lock = threading.RLock()
        self._jobs = OrderedDict()
        self._active_id = None
        self._cache_hits = 0
        self._closed = False

    def _prune(self):
        now = self.clock()
        for job_id, job in list(self._jobs.items()):
            if job_id != self._active_id and now - job["updated"] > self.ttl_seconds:
                del self._jobs[job_id]
        while (len(self._jobs) > self.max_jobs or sum(job["resultBytes"] for job in self._jobs.values()) > self.max_result_bytes):
            victim = next((job_id for job_id in self._jobs if job_id != self._active_id), None)
            if victim is None:
                break
            del self._jobs[victim]

    @staticmethod
    def _public(job, cached=False):
        result = {"jobId": job["jobId"], "state": job["state"], "progress": dict(job["progress"]),
                  "cancelRequested": job["cancel"].is_set(), "cached": cached}
        if job.get("result") is not None:
            result["result"] = job["result"]
        if job.get("error") is not None:
            result["error"] = dict(job["error"])
        return result

    def submit(self, payload):
        validate_parameters(payload)
        # The hash includes original image bytes and every option. Results from
        # a different image, angle, threshold or scan profile cannot be reused.
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"),
                                                 allow_nan=False).encode("utf-8")).hexdigest()
        with self._lock:
            self._prune()
            for job in self._jobs.values():
                if job["fingerprint"] == fingerprint and job["state"] in {"queued", "running", "completed"} and not job["cancel"].is_set():
                    self._cache_hits += int(job["state"] == "completed")
                    return self._public(job, cached=job["state"] == "completed")
            if self._closed or self._active_id is not None or self.engine.health().get("busy"):
                raise BlockingIOError("An OCR scan is already running; cancel it or wait for completion")
        # Reject bad encodings/dimensions before accepting a job. Only this
        # bounded in-memory decode happens on the request thread.
        try:
            image = decode_image(payload.get("image"))
            image.close()
        except ImportError as exc:
            raise OcrUnavailable("Pillow is not installed") from exc
        with self._lock:
            if self._closed or self._active_id is not None:
                raise BlockingIOError("An OCR scan is already running")
            job_id = uuid.uuid4().hex
            job = {"jobId": job_id, "state": "queued", "cancel": threading.Event(),
                   "fingerprint": fingerprint, "updated": self.clock(), "resultBytes": 0,
                   "progress": {"stage": "queued", "completed": 0, "total": 1, "message": "Waiting for local OCR worker"}}
            self._jobs[job_id] = job
            self._active_id = job_id
            self._prune()
            thread = threading.Thread(target=self._run, args=(job_id, dict(payload)), daemon=True,
                                      name="ping-location-ocr")
            thread.start()
            return self._public(job)

    def _run(self, job_id, payload):
        def progress(value):
            with self._lock:
                job = self._jobs[job_id]
                job["progress"] = dict(value)
                job["updated"] = self.clock()
        with self._lock:
            job = self._jobs[job_id]
            job["state"] = "running"
        try:
            result = self.engine.recognize(payload, progress=progress, cancel_event=job["cancel"])
            if job["cancel"].is_set():
                raise OcrCancelled("OCR scan was cancelled")
            result_bytes = len(json.dumps(result, separators=(",", ":"), allow_nan=False).encode("utf-8"))
            if result_bytes > self.max_result_bytes:
                raise InputError("OCR result exceeded the bounded in-memory cache")
            with self._lock:
                job["result"] = result
                job["resultBytes"] = result_bytes
                job["state"] = "completed"
        except OcrCancelled:
            with self._lock:
                job["state"] = "cancelled"
                job["progress"] = {**job["progress"], "stage": "cancelled", "message": "Scan cancelled"}
        except Exception as exc:
            code = "ocr_unavailable" if isinstance(exc, OcrUnavailable) else "ocr_busy" if isinstance(exc, BlockingIOError) else "invalid_request" if isinstance(exc, InputError) else "ocr_failed"
            message = str(exc) if isinstance(exc, (OcrUnavailable, BlockingIOError, InputError)) else "Local OCR failed; check the service terminal"
            with self._lock:
                job["state"] = "failed"
                job["error"] = {"code": code, "message": message}
                job["progress"] = {**job["progress"], "stage": "failed", "message": message}
            if code == "ocr_failed":
                print(f"OCR job failed: {type(exc).__name__}", flush=True)
        finally:
            # This is the only object holding screenshot data after submit.
            # The cache keeps coordinates/text, never the payload or pixels.
            payload.clear()
            with self._lock:
                job["updated"] = self.clock()
                if self._active_id == job_id:
                    self._active_id = None
                self._prune()

    def get(self, job_id):
        with self._lock:
            self._prune()
            if job_id not in self._jobs:
                raise JobNotFound(job_id)
            return self._public(self._jobs[job_id])

    def cancel(self, job_id):
        with self._lock:
            self._prune()
            if job_id not in self._jobs:
                raise JobNotFound(job_id)
            job = self._jobs[job_id]
            if job["state"] in {"queued", "running"}:
                job["cancel"].set()
                job["progress"] = {**job["progress"], "message": "Cancellation requested; finishing the current bounded OCR pass"}
            return self._public(job)

    def health(self):
        with self._lock:
            self._prune()
            active = self._public(self._jobs[self._active_id]) if self._active_id else None
            return {"jobsApi": 1, "activeJob": active,
                    "cache": {"entries": len(self._jobs), "hits": self._cache_hits, "ttlSeconds": self.ttl_seconds,
                              "maxEntries": self.max_jobs, "resultBytes": sum(job["resultBytes"] for job in self._jobs.values()),
                              "maxResultBytes": self.max_result_bytes}}

    def close(self):
        with self._lock:
            self._closed = True
            for job in self._jobs.values():
                if job["state"] in {"queued", "running"}:
                    job["cancel"].set()
