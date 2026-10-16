# Dịch vụ OCR cục bộ

Chạy trong thư mục `ping-location`, với Python 3.12:

```powershell
python -m pip install -r service/requirements.txt
python -m service
```

Nếu máy có nhiều bản Python, dùng đường dẫn đầy đủ đến `python.exe`. Dịch vụ chỉ nghe tại `127.0.0.1:8766`; ảnh chỉ xử lý trong bộ nhớ. Lần quét đầu tiên cần nạp mô hình vào RAM nên chậm hơn các lần sau.

Sau khi cập nhật mã nguồn, đóng cửa sổ dịch vụ cũ rồi chạy lại. `/health` của bản mới trả `version: 2` và `jobsApi: 1`; tiến trình cũ không tự nạp lại mã.

Mô hình được tìm ở `.models/easyocr`, `.models`, thư mục mô hình của dự án cạnh bên `plan-sync-review`, cấu hình EasyOCR và `~/.EasyOCR/model`. Có thể chỉ định `--model-dir "D:\duong-dan\easyocr"` hoặc biến `PING_LOCATION_MODEL_DIR`. Cần hai tệp `craft_mlt_25k.pth` và `english_g2.pth`. Chế độ thường **không tải mô hình**. Nếu chưa có, chủ động tải một lần:

```powershell
python -m service --download-models
python -m service
```

`--download-models` ghi mô hình vào `.models/easyocr` của dự án rồi thoát. Dùng `--model-dir` để đổi nơi tải. Chỉ dùng trọng số từ nguồn tin cậy.

## API

- `GET /health`: `ok`, `ocrReady`, `modelsAvailable`, `dependencies`, `modelDirectory`, `missingModels`, `loaded`, `loadError`, `downloadEnabled`, `workerWarm`, `busy`, `lastScan`, `jobsApi`, `activeJob`, `cache`. Kiểm tra này không nạp mô hình; lần OCR đầu tiên kiểm tra tính hợp lệ thực tế của trọng số.
- `POST /jobs`, JSON: `{ "image": "data:image/png;base64,...", "profile": "quick", "minConfidence": 0.3 }` → 202 với `{ "jobId": "...", "state": "queued", "progress": {"stage":"queued","completed":0,"total":1,"message":"..."}, "cached":false, "cancelRequested":false }`. Tiến trình có thể đã chuyển sang `running` hoặc `completed` khi phản hồi tới. `angles` và `scale` tùy chọn như bên dưới.
- `GET /jobs/{jobId}`: đọc tiến độ mỗi giây. `state` là `queued`, `running`, `completed`, `failed` hoặc `cancelled`. Khi hoàn thành có `result` theo hợp đồng OCR bên dưới; khi thất bại có `error: {code,message}`. Progress còn có thể chứa `found`, `angle`, `batch`, `batches`.
- `DELETE /jobs/{jobId}` → 202, đặt `cancelRequested: true` nếu còn chạy. Việc hủy được kiểm tra giữa các góc, tile và nhóm nhận dạng; lượt suy luận đang chạy cần kết thúc trước. Mã không tồn tại/hết hạn trả 404. Chỉ một job hoạt động; job khác trả 429. Gửi lại cùng ảnh và tùy chọn dùng lại job đang chạy hoặc kết quả đã có.
- Cache kết quả chỉ lưu tọa độ/chữ trong RAM, tối đa 8 bản ghi, 64 MiB, hết hạn sau 10 phút. Ảnh không nằm trong cache kết quả. `/health.cache` cho biết kích thước và số lượt dùng lại.
- `POST /ocr` vẫn hỗ trợ đồng bộ để tương thích. Dùng `/jobs` cho extension để tránh giữ một HTTP request suốt thời gian OCR.
- Tùy chọn nhận dạng: `profile: "quick"` mặc định ước lượng **một hướng chữ chính**, giới hạn detector 1280 px và dùng scale 1; `profile: "thorough"` dùng nhiều hướng ước lượng, tile 900 px chồng 100 px, mặc định scale 2. Nếu cung cấp `angles: [0,30,60,90,120,150]` thì thử đủ các góc đã yêu cầu. Tối đa 12 góc, -360 đến 360 độ; scale 1 đến 3, tự giới hạn theo ngân sách ảnh. Góc dương xoay ảnh ngược chiều kim đồng hồ. Mỗi hộp chữ còn được thử 180 độ. Hướng chữ tự động chỉ là ước lượng hình học, không sửa hoặc đoán mã căn.
- Kết quả: `{ "width": 1920, "height": 1080, "detections": [{ "code": "VX-002", "raw": "VX-002", "confidence": 0.95, "x": 150, "y": 200, "box": [[130,190],[170,190],[170,210],[130,210]], "angle": 30 }], "warnings": [] }`. Tất cả tọa độ tính theo pixel ảnh đầu vào, trước phóng to hoặc xoay; `x,y` là tâm nhãn chữ, chưa phải tâm đa giác căn.
- `POST /feedback`: `{ "code": "VX-002", "raw": "VX-OO2", "x": 150, "y": 200, "kind": "corrected", "context": {"scene":"example"} }`. Dữ liệu lưu ở `service/.data/feedback.jsonl`, có thời gian UTC. Không nhận ảnh hoặc chuỗi dữ liệu ảnh. Phản hồi: `{ "ok": true, "saved": true, "trainingApplied": false }`.

Phản hồi đã xác nhận giúp tạo tập dữ liệu kiểm chứng; dịch vụ chưa tự huấn luyện lại EasyOCR. Không tự thay chữ O bằng số 0, không tự đoán căn theo hàng chẵn/lẻ. Các kết quả cùng mã ở hai vị trí khác nhau vẫn được giữ để bên gọi xử lý trường hợp mơ hồ.

Ảnh chụp mẫu có chữ trên bản đồ chỉ khoảng 8 pixel cao: các thử nghiệm phóng to/xoay và lọc mực xanh chưa nhận dạng đúng ổn định. Cần phóng to bản đồ ngay trên trang để lấy chữ nét hơn; phóng to ảnh cũ không khôi phục chi tiết đã mất. Bên gọi phải loại vùng bảng quản lý và các nút ra khỏi vị trí bấm vì OCR cũng có thể đọc mã căn trong bảng này.

Chỉ nhận Origin extension Chrome hợp lệ và `http(s)://localhost[:port]` hoặc `http(s)://127.0.0.1[:port]`; các công cụ dòng lệnh không gửi Origin vẫn dùng được. Host phải là localhost hoặc 127.0.0.1 với đúng cổng. API yêu cầu `Content-Type: application/json`; hỗ trợ OPTIONS/CORS. Ảnh PNG/JPEG dưới 12 MiB, mỗi cạnh tối đa 8192 px, tổng tối đa 20 triệu pixel; HTTP body OCR dưới 18 MiB. Chỉ một lượt OCR chạy đồng thời; lượt khác trả 429. 503 nghĩa là cần kiểm tra mô hình/dependency trong `/health`.

Nguyên nhân chờ lâu ở bản cũ: sáu lượt ảnh toàn màn hình phóng 2×, cộng với EasyOCR đệm mọi mảnh chữ theo mảnh rộng nhất khi thử xoay 180°. Một tên đường dài có thể làm hàng trăm nhãn nhỏ tốn CPU và RAM lớn. Bản mới tách detection/recognition và gom chữ theo độ rộng, giới hạn mỗi nhóm 48 hộp, xử lý CPU tối đa 4 luồng. Timeout socket 20 giây chỉ áp dụng đọc dữ liệu request, không giới hạn thời gian suy luận; API job cho phép giao diện tiếp tục nhận tiến độ.

Đo trên máy này với ảnh mẫu 1908×986: quét nhanh toàn ảnh 22,431 giây, gồm khoảng 8,55 giây nạp mô hình lạnh; vùng `[100,100,1350,900]` dùng mô hình đã nạp mất 19,682 giây. Toàn ảnh chỉ đọc được vài mã ở bảng quản lý; vùng bản đồ chưa đọc được nhãn đáng tin cậy. Thời gian phụ thuộc số chữ, máy và tác vụ đang chạy; đây không phải cam kết thời gian hay độ chính xác. Cần zoom bản đồ trực tiếp và giới hạn vùng quét.

## Kiểm tra

```powershell
python -m unittest discover -s service/tests -v
```

Thử ảnh thật (báo cáo không chứa ảnh) bằng `python -m service.tools.smoke duong-dan-anh.jpg --crop 930 285 1180 590 --angles 330 --scale 3 --expected VN50-01 VN50-02 VN50-03 VN50-04 VN50-05 VN50-06 VN50-07 VN50-08 VN50-09`. Với ảnh mẫu được cung cấp, vùng này có 9 nhãn đối chiếu; lần thử đầu chưa nhận đúng mã nào ở ngưỡng 0,3. Báo cáo mặc định: `tmp/ocr-smoke-report.json`. Đây chỉ là một vùng ảnh mẫu, không phải ước lượng độ chính xác chung.

Tái lập đo tốc độ: `python -m service.tools.benchmark duong-dan-anh.jpg --roi 100 100 1350 900`. Kết quả tại `tmp/ocr-quick-benchmark.json`, không chứa dữ liệu ảnh.

Tài liệu API tham khảo: [EasyOCR](https://www.jaided.ai/easyocr/documentation/), [phép biến đổi affine OpenCV](https://docs.opencv.org/4.x/d4/d61/tutorial_warp_affine.html).
