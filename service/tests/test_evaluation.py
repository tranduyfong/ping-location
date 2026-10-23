import unittest

from service.tools.evaluate import score_codes


class EvaluationTests(unittest.TestCase):
    def test_duplicate_predictions_are_not_counted_as_multiple_correct_labels(self):
        result = score_codes(["KĐ7-93"], [{"code": "KĐ7-93"}, {"code": "KĐ7-93"}])
        self.assertEqual(result["correctCount"], 1)
        self.assertEqual(result["codeRecall"], 1)
        self.assertEqual(result["codePrecision"], 0.5)
        self.assertEqual(result["extraCodes"], ["KĐ7-93"])

    def test_vietnamese_aliases_are_errors_and_missing_predictions_stay_missing(self):
        result = score_codes(["KĐ7-93", "ĐLSH-173"], [{"code": "KD7-93"}])
        self.assertEqual(result["correctCount"], 0)
        self.assertEqual(result["missingCodes"], ["KĐ7-93", "ĐLSH-173"])
        self.assertEqual(result["extraCodes"], ["KD7-93"])

    def test_no_predictions_does_not_claim_perfect_precision(self):
        result = score_codes(["VM2-23"], [])
        self.assertEqual(result["codeRecall"], 0)
        self.assertIsNone(result["codePrecision"])


if __name__ == "__main__":
    unittest.main()
