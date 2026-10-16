import base64
import http.client
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from service.ocr import (InputError, OcrEngine, decode_image, extract_codes,
                         inverse_points, rotation_transform, validate_parameters)
from service.server import LocalServer, MAX_BODY_BYTES, allowed_origin, validate_feedback


def image_url(size=(80, 60)):
    output = io.BytesIO()
    Image.new("RGB", size, "white").save(output, "PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


class CodeTests(unittest.TestCase):
    def test_preserves_code_shapes_and_leading_zeroes(self):
        for code in ("VN48-123", "ASP-233", "VX-002", "VNB.TP.1-345", "VX-02", "VX-04"):
            self.assertEqual(extract_codes(code), [code])

    def test_normalizes_unicode_dash_spaces_and_case(self):
        self.assertEqual(extract_codes("vnb . tp . 1 – 003"), ["VNB.TP.1-003"])
        self.assertEqual(extract_codes("VN48-123\n276.4 m²"), ["VN48-123"])

    def test_never_repairs_or_extracts_partial_codes(self):
        for raw in ("VX-OO2", "VX-02B", "VX-1234567", "276.4 m2", "VN48 123", "VX--02"):
            self.assertEqual(extract_codes(raw), [], raw)
        self.assertEqual(extract_codes("VX-002 ASP-233"), ["VX-002", "ASP-233"])


class GeometryTests(unittest.TestCase):
    def test_inverse_for_rectangular_scaled_images_and_arbitrary_angles(self):
        original = np.array([[13.5, 11], [53, 11], [53, 27], [13.5, 27]])
        for angle in (0, 30, 60, 90, 120, 150, 180, 270, 17.25):
            matrix, size = rotation_transform(187, 113, angle)
            scaled = original * np.array([1.7, 1.6])
            rotated = scaled @ matrix[:, :2].T + matrix[:, 2]
            np.testing.assert_allclose(inverse_points(rotated, matrix, 1.7, 1.6), original, atol=1e-7)
            corners = np.array([[0, 0], [187, 0], [187, 113], [0, 113]])
            transformed = corners @ matrix[:, :2].T + matrix[:, 2]
            self.assertTrue((transformed >= -1e-7).all())
            self.assertTrue((transformed <= np.array(size) + 1e-7).all())
        self.assertEqual(rotation_transform(187, 113, 90)[1], (113, 187))

    def test_fake_rotated_ocr_returns_original_coordinates(self):
        engine = OcrEngine()
        matrix, _ = rotation_transform(120, 90, 30)
        original_box = np.array([[20, 20], [40, 20], [40, 30], [20, 30]])
        rotated = original_box * 1.5 @ matrix[:, :2].T + matrix[:, 2]

        class Reader:
            def readtext(self, image, **kwargs):
                return [(rotated.tolist(), "VX-002", 0.98)]

        engine._reader = Reader()
        result = engine.recognize({"image": image_url(), "angles": [30], "scale": 1.5})
        self.assertEqual((result["width"], result["height"]), (80, 60))
        self.assertEqual(len(result["detections"]), 1)
        self.assertAlmostEqual(result["detections"][0]["x"], 30)
        self.assertAlmostEqual(result["detections"][0]["y"], 25)


class ValidationTests(unittest.TestCase):
    def test_bad_parameters(self):
        for payload in ({"angles": []}, {"angles": [float("nan")]}, {"angles": [True]},
                        {"scale": 4}, {"scale": False}, {"minConfidence": -1}, {"minConfidence": float("inf")}):
            with self.assertRaises(InputError):
                validate_parameters(payload)
        self.assertEqual(validate_parameters({"angles": [0, 360, -30]})[0], [0, 330])
        self.assertEqual(validate_parameters({"scale": 3})[2], 3)

    def test_bad_or_oversized_image(self):
        for value in ("https://example.com/image.png", "data:image/png;base64,@@@", "data:image/png;base64,YWJj", None):
            with self.assertRaises(InputError):
                decode_image(value)
        with patch("service.ocr.MAX_IMAGE_DIMENSION", 79):
            with self.assertRaises(InputError):
                decode_image(image_url())

    def test_origin_rules(self):
        self.assertTrue(allowed_origin(None))
        self.assertTrue(allowed_origin("chrome-extension://" + "a" * 32))
        self.assertTrue(allowed_origin("http://127.0.0.1:4100"))
        for origin in ("null", "https://evil.example", "https://localhost.evil.example", "http://localhost:4@evil.example"):
            self.assertFalse(allowed_origin(origin))

    def test_feedback_retention_rules(self):
        payload = {"code": "VX-002", "raw": "VX-OO2", "x": 20, "y": 30, "kind": "corrected", "context": {"scene": "one"}}
        self.assertEqual(validate_feedback(payload)["code"], "VX-002")
        for change in ({"image": image_url()}, {"context": {"image": "anything"}}, {"x": float("nan")},
                       {"context": {"value": "data:image/png;base64,xyz"}}, {"raw": "data:image/png;base64,xyz"},
                       {"context": {"value": float("inf")}}):
            with self.assertRaises((InputError, ValueError)):
                validate_feedback({**payload, **change})


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.feedback_path = Path(self.directory.name) / "feedback.jsonl"
        self.server = LocalServer(("127.0.0.1", 0), OcrEngine(Path(self.directory.name)), self.feedback_path)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=4)
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        data = response.read()
        result = response.status, dict(response.getheaders()), json.loads(data) if data else None
        connection.close()
        return result

    def test_health_and_cors(self):
        status, headers, data = self.request("GET", "/health", headers={"Origin": "chrome-extension://" + "a" * 32})
        self.assertEqual(status, 200)
        self.assertFalse(data["modelsAvailable"])
        self.assertFalse(data["downloadEnabled"])
        self.assertEqual(headers["Access-Control-Allow-Origin"], "chrome-extension://" + "a" * 32)
        status, headers, _ = self.request("GET", "/health", headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.request("GET", "/health", headers={"Host": "evil.example"})[0], 403)

    def test_preflight(self):
        status, headers, _ = self.request("OPTIONS", "/ocr", headers={"Origin": "http://localhost:5000"})
        self.assertEqual(status, 204)
        self.assertIn("POST", headers["Access-Control-Allow-Methods"])

    def test_validation_and_size_before_reading(self):
        self.assertEqual(self.request("POST", "/ocr", "{}", {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/ocr", "NaN", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/ocr", "[]", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/ocr", json.dumps({"image": image_url(), "angles": [True]}), {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/ocr", json.dumps({"image": image_url(), "minConfidence": -1}), {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/ocr", "{}", {"Content-Type": "application/json", "Content-Length": str(MAX_BODY_BYTES + 1)})[0], 413)
        self.assertEqual(self.request("POST", "/ocr", json.dumps({"image": image_url(), "angles": [0]}), {"Content-Type": "application/json"})[0], 503)

    def test_valid_ocr_endpoint_preserves_contract(self):
        response = {"width": 80, "height": 60, "detections": [{"code": "VX-002", "raw": "VX-002", "confidence": 0.98,
                    "x": 30, "y": 25, "box": [[20, 20], [40, 20], [40, 30], [20, 30]], "angle": 17.25}], "warnings": []}
        payload = {"image": image_url(), "angles": [17.25], "minConfidence": 0.7, "scale": 3}
        with patch.object(self.server.engine, "recognize", return_value=response) as recognize:
            status, _, actual = self.request("POST", "/ocr", json.dumps(payload), {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(actual, response)
        recognize.assert_called_once_with(payload)

    def test_repeated_early_rejections_deliver_complete_http_responses(self):
        # http.client sends headers and body separately. On Windows, closing
        # with the small body unread used to intermittently reset the socket
        # before getresponse() could receive the 415 status.
        for attempt in range(40):
            with self.subTest(attempt=attempt):
                self.assertEqual(self.request("POST", "/ocr", "{}", {"Content-Type": "text/plain"})[0], 415)
                self.assertEqual(self.request("POST", "/ocr", "{}", {"Content-Type": "application/json", "Content-Length": str(MAX_BODY_BYTES + 1)})[0], 413)

    def test_oversized_declaration_rejected_without_waiting_for_body(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=1)
        connection.putrequest("POST", "/ocr")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str(MAX_BODY_BYTES + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        self.assertEqual(json.loads(response.read())["error"], "request_too_large")
        connection.close()

    def test_feedback_writes_one_record_without_image(self):
        payload = {"code": "VX-002", "raw": "VX-OO2", "x": 20, "y": 30, "kind": "corrected", "context": {"scene": "one"}}
        status, _, data = self.request("POST", "/feedback", json.dumps(payload), {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertFalse(data["trainingApplied"])
        record = json.loads(self.feedback_path.read_text(encoding="utf-8"))
        self.assertEqual(record["code"], "VX-002")
        self.assertNotIn("image", record)
        self.assertIn("createdAt", record)

    def test_async_http_job_completion_cache_and_missing_route(self):
        result = {"width": 80, "height": 60, "detections": [], "warnings": []}
        def recognize(body, progress, cancel_event):
            progress({"stage": "completed", "completed": 1, "total": 1, "message": "Done"})
            return result
        body = json.dumps({"image": image_url()})
        with patch.object(self.server.engine, "recognize", side_effect=recognize):
            status, _, job = self.request("POST", "/jobs", body, {"Content-Type": "application/json"})
            self.assertEqual(status, 202)
            for attempt in range(100):
                _, _, completed = self.request("GET", "/jobs/" + job["jobId"])
                if completed["state"] == "completed":
                    break
                threading.Event().wait(0.005)
            self.assertEqual(completed["state"], "completed")
            self.assertEqual(completed["result"], result)
            _, _, cached = self.request("POST", "/jobs", body, {"Content-Type": "application/json"})
            self.assertTrue(cached["cached"])
            self.assertEqual(cached["jobId"], job["jobId"])
            self.assertEqual(self.request("DELETE", "/jobs/" + job["jobId"])[0], 202)
        self.assertEqual(self.request("GET", "/jobs/" + "0" * 32)[0], 404)
        self.assertEqual(self.request("DELETE", "/jobs/" + "0" * 32)[0], 404)
        _, headers, _ = self.request("OPTIONS", "/jobs", headers={"Origin": "http://localhost:5000"})
        self.assertIn("DELETE", headers["Access-Control-Allow-Methods"])


if __name__ == "__main__":
    unittest.main()
