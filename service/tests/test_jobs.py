import base64
import io
import json
import threading
import time
import unittest

from PIL import Image

from service.jobs import JobManager, JobNotFound
from service.ocr import InputError, OcrCancelled, OcrEngine, OcrUnavailable, adaptive_angles, image_tiles, read_bounded


def payload(value=0.25):
    output = io.BytesIO()
    Image.new("RGB", (80, 60), "white").save(output, "PNG")
    return {"image": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii"),
            "minConfidence": value}


class FakeEngine:
    def __init__(self, error=None):
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        self.error = error

    def health(self):
        return {"busy": False}

    def recognize(self, body, progress, cancel_event):
        self.calls += 1
        progress({"stage": "recognizing", "completed": 0, "total": 2, "message": "First bounded pass"})
        self.started.set()
        while not self.release.wait(0.01):
            if cancel_event.is_set():
                raise OcrCancelled("cancelled")
        if self.error:
            raise self.error
        progress({"stage": "completed", "completed": 2, "total": 2, "message": "Finished"})
        return {"width": 80, "height": 60, "detections": [], "warnings": []}


class JobTests(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.manager = JobManager(self.engine)

    def tearDown(self):
        self.manager.close()
        self.engine.release.set()

    def wait_for(self, job_id, state):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            job = self.manager.get(job_id)
            if job["state"] == state:
                return job
            threading.Event().wait(0.005)
        self.fail(f"job did not reach {state}")

    def test_live_progress_one_active_and_cooperative_cancel(self):
        job = self.manager.submit(payload())
        self.assertTrue(self.engine.started.wait(1))
        current = self.manager.get(job["jobId"])
        self.assertEqual(current["state"], "running")
        self.assertEqual(current["progress"]["total"], 2)
        with self.assertRaises(BlockingIOError):
            self.manager.submit(payload(0.5))
        self.assertEqual(self.manager.submit(payload())["jobId"], job["jobId"])
        self.assertTrue(self.manager.cancel(job["jobId"])["cancelRequested"])
        cancelled = self.wait_for(job["jobId"], "cancelled")
        self.assertNotIn("result", cancelled)
        self.assertNotIn("data:image", json.dumps(cancelled))

    def test_completed_job_reused_and_cache_size_bounded(self):
        self.manager.max_jobs = 2
        self.engine.release.set()
        first = self.manager.submit(payload())
        completed = self.wait_for(first["jobId"], "completed")
        self.assertIn("result", completed)
        cached = self.manager.submit(payload())
        self.assertTrue(cached["cached"])
        self.assertEqual(cached["jobId"], first["jobId"])
        self.assertEqual(self.engine.calls, 1)
        for confidence in (0.4, 0.5):
            job = self.manager.submit(payload(confidence))
            self.wait_for(job["jobId"], "completed")
        self.assertLessEqual(self.manager.health()["cache"]["entries"], 2)
        with self.assertRaises(JobNotFound):
            self.manager.get(first["jobId"])

    def test_results_expire_by_ttl(self):
        now = [0.0]
        self.manager.clock = lambda: now[0]
        self.manager.ttl_seconds = 10
        self.engine.release.set()
        job = self.manager.submit(payload())
        self.wait_for(job["jobId"], "completed")
        now[0] = 11
        with self.assertRaises(JobNotFound):
            self.manager.get(job["jobId"])
        self.assertEqual(self.manager.health()["cache"]["entries"], 0)

    def test_failed_models_expose_machine_error_and_no_result(self):
        self.engine.error = OcrUnavailable("models missing")
        self.engine.release.set()
        job = self.manager.submit(payload())
        failed = self.wait_for(job["jobId"], "failed")
        self.assertEqual(failed["error"]["code"], "ocr_unavailable")
        self.assertNotIn("result", failed)

    def test_large_results_fail_with_bounded_cache_and_bad_images_rejected(self):
        self.manager.max_result_bytes = 8
        self.engine.release.set()
        job = self.manager.submit(payload())
        failed = self.wait_for(job["jobId"], "failed")
        self.assertEqual(failed["error"]["code"], "invalid_request")
        self.assertEqual(self.manager.health()["cache"]["resultBytes"], 0)
        with self.assertRaises(InputError):
            self.manager.submit({"image": "https://example.com/image.png"})


class AdaptiveScanTests(unittest.TestCase):
    def test_blank_image_falls_back_to_two_orthogonal_angles(self):
        self.assertEqual(adaptive_angles(Image.new("RGB", (80, 60), "white")), [0, 90])

    def test_tiles_cover_wide_images_and_overlap(self):
        tiles = image_tiles(1908, 986)
        self.assertEqual(len(tiles), 6)
        self.assertTrue(all(right - left <= 900 and bottom - top <= 900 for left, top, right, bottom in tiles))
        self.assertEqual(max(right for left, top, right, bottom in tiles), 1908)
        self.assertEqual(max(bottom for left, top, right, bottom in tiles), 986)

    def test_cancel_checked_between_passes(self):
        engine = OcrEngine()
        cancel = threading.Event()
        calls = []
        class Reader:
            def readtext(self, image, **kwargs):
                calls.append(1)
                cancel.set()
                return []
        engine._reader = Reader()
        body = {**payload(), "angles": [0, 90]}
        with self.assertRaises(OcrCancelled):
            engine.recognize(body, cancel_event=cancel)
        self.assertEqual(len(calls), 1)

    def test_recognition_buckets_keep_street_width_out_of_short_label_batches(self):
        import numpy as np
        calls = []
        class Reader:
            def detect(self, image, **kwargs):
                return [[[0, 40, 0, 10], [0, 100, 0, 10], [0, 5, 0, 10], [0, 1000, 0, 10]]], [[]]
            def recognize(self, image, **kwargs):
                calls.append(kwargs["horizontal_list"])
                return [([[0, 0], [40, 0], [40, 10], [0, 10]], "VX-002", 0.12)]
        results = read_bounded(Reader(), np.zeros((80, 1200, 3), dtype=np.uint8), 1280, lambda: None,
                               lambda *args: None)
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(len(batch) == 1 for batch in calls))
        self.assertEqual([result[1] for result in results], ["VX-002", "VX-002"])
        self.assertEqual(results[0][2], 0.12)


if __name__ == "__main__":
    unittest.main()
