# Tiếng Việt và hai ảnh người dùng — 23/10/2026

## Đầu vào đã xem

| Tệp | Kích thước | Nội dung |
|---|---|---|
| `data/Screenshot 2026-10-23 140532.png` | 1904 × 876, khoảng 2,36 MB | VHub: các dãy Kinh Đô và bảng Chờ gắn |
| `data/TMB-2.jpg` | 30000 × 21219, khoảng 39,26 MB | Hải Vân Bay, khu Vịnh Mây |

Đây là hai mặt bằng khác nhau. Đã chuẩn bị vùng kiểm chứng riêng cho cả hai theo yêu cầu người dùng; không dùng tọa độ ảnh này để gắn trên ảnh kia. Ảnh gốc giữ nguyên. Ảnh Hải Vân Bay có hơn 636 triệu pixel: đã tạo ảnh xem tổng quan bằng JPEG draft, sau đó lấy vùng nhỏ ở độ phân giải gốc để đo OCR. Việc lấy vùng gốc trong phiên này có kiểm tra RAM và giới hạn kích thước tệp cụ thể; chưa bổ sung luồng tự nhập/quét toàn bộ ảnh lớn vào tiện ích.

## Những lỗi đã sửa trong 0.3.0

- Bộ lọc cũ chỉ nhận A–Z, làm loại `KĐ7-93` và có thể cắt `ĐLSH-173` thành `LSH-173`. Bộ đọc DOM/SVG, core và backend nay giữ chữ Unicode, dấu tiếng Việt và dạng dấu tổ hợp sau chuẩn hóa. `Đ` khác `D`, số 0 đầu vẫn được giữ.
- Đổi OCR từ `en`/`english_g2.pth` sang `vi` + `en`/`latin_g2.pth`. Health báo rõ ngôn ngữ và mô hình. Chỉ có trọng số tiếng Anh không được báo sẵn sàng cho bản tiếng Việt. [Cấu hình EasyOCR chính thức](https://github.com/JaidedAI/EasyOCR/blob/master/easyocr/config.py) có bộ ký tự tiếng Việt trong mô hình Latin; đây là dùng mô hình có sẵn, không phải đã fine-tune từ hai ảnh.
- Hộp chữ xoay trước đây được lọc bằng tỷ lệ khung bao thẳng đứng/ngang. Chữ dài xoay 45° có khung gần vuông nên bị loại. Nay đo theo cạnh tứ giác mà OCR dùng để nắn chữ, kèm kiểm thử hồi quy.
- Quét nhanh tự động luôn giữ góc 0° và thêm hướng chính nếu khác 0°, tối đa hai lượt. Đây là góc dự phòng cho ảnh có nhãn nhiều hướng; có thể tốn thêm thời gian. Vùng lớn/chữ nhỏ vẫn có thể chưa đọc được.

## Kết quả thực tế và giới hạn

Người dùng đã xác nhận đúng cả hai nhóm mã bản đồ: tám mã KĐ7-93/95/97/99/101/103/105/107 và sáu mã VM2-23/25/27/29/31/33, tổng cộng **14 nhãn chuẩn**. Nhãn vùng bảng vẫn là tham chiếu do trợ lý đọc, chưa được xác nhận riêng. Kết quả áp dụng đúng những vùng và tham số đã ghi trong manifest, chưa đại diện toàn dự án.

| Vùng thử | Đúng / số nhãn đối chiếu | Dự đoán thêm chưa khớp | Ghi chú |
|---|---:|---|---|
| Bản đồ VHub, crop `[900,350,1130,690]` | **1/8** | `K07-100` | Đúng `KĐ7-101`; thorough, góc 20/25/30°, scale 3 |
| Hải Vân Bay, crop gốc `[17900,13950,18250,14550]` | **5/6** | Không | Đúng VM2-23/25/29/31/33, thiếu VM2-27; thorough, góc 0°, scale 2 |
| Bảng Chờ gắn VHub, crop `[1460,260,1830,560]` | **5/5** | `TTS-27` | Chỉ là vùng tham chiếu chữ; **không được dùng làm vị trí bản đồ** |

Lần chạy bằng công cụ đánh giá: khoảng 20,19 giây cho vùng VHub gồm nạp mô hình lạnh, 3,64 giây cho vùng Hải Vân Bay đã nạp mô hình, 2,29 giây cho vùng bảng. Thời gian có thể thay đổi theo tải máy. Bảng giá có chữ tương tự mã (`TTS-27`) là ví dụ vì sao phải loại giao diện khỏi vùng bản đồ và đối chiếu danh sách căn hợp lệ.

So sánh cùng bộ lọc Unicode: mô hình tiếng Anh làm mất dấu trong các mã bảng (`KD7-93`, `DLSH-173`...), mô hình tiếng Việt đọc đúng cả năm mã ở vùng này. Mẫu tổng hợp sáu mã rõ gồm `KĐ7-93`, `ĐLSH-173`, `ĐÔNG-002`, `VM3-28`, `VN48-123`, `VX-002` được mô hình tiếng Việt đọc đúng **6/6**; không gộp mẫu tổng hợp vào số đo bản đồ thật.

Quét nhanh vùng Hải Vân Bay lớn hơn vẫn chưa tìm đúng mã; thu hẹp vùng và scale 2 mới đạt 5/6. Chưa có bằng chứng rằng chỉ đổi mô hình hoặc chỉ sửa hình học hộp chữ đã giải quyết mọi nhãn. Trên VHub, chữ nhỏ/xoay/đè biểu tượng vẫn là điểm nghẽn. Cần ảnh chụp bản đồ zoom rõ hơn để thử tiếp.

**Chưa đo độ chính xác điểm bấm:** bộ mẫu hiện chỉ có mã, ảnh và vùng cắt, chưa có đường bao lô/điểm bấm chuẩn. Tâm chữ OCR không được xem là bằng chứng điểm nằm an toàn trong đúng lô. Chưa thử gắn hoặc sửa dữ liệu VHub thật trong phiên kiểm thử.

## Bộ mẫu và vòng xác nhận

`data/learning/manifest.json` lưu SHA-256 hai tệp nguồn, kích thước, crop gốc, mã đối chiếu, tham số OCR và `reviewStatus`. Ba crop nhỏ nằm bên cạnh manifest. Dữ liệu này được giữ cục bộ, nằm trong thư mục bỏ qua Git.

- Hai vùng bản đồ thuộc vai trò `map`; bảng Chờ gắn là `ui-reference`, báo riêng.
- Hai mẫu bản đồ đã có trạng thái `confirmed-user`, thời gian và nội dung xác nhận; nguồn đọc ban đầu vẫn giữ là `assistant-visual-read`. Mẫu bảng giữ `pending-user`. Việc xác nhận không thay đổi mã đối chiếu hay số đo đã chạy, nên không cần chạy lại suy luận.
- Chưa huấn luyện lại trọng số. Các mẫu trước tiên phục vụ đo lỗi và so sánh phiên bản. Cần giữ thêm vùng mới chưa dùng điều chỉnh để đánh giá khả năng áp dụng rộng hơn.
- Bước tiếp theo: thu thêm crop các mã còn thiếu/sai và điểm bên trong đúng lô; ưu tiên ảnh VHub đã zoom rõ. Giữ cả mẫu khó và một số mẫu hệ thống tự tin để tìm lỗi tự tin sai.

Chạy lại phép đo, không gắn lên VHub:

```powershell
.\.venv\Scripts\python.exe -m service.tools.evaluate data\learning\manifest.json --out tmp\labelled-crop-evaluation.json
```

Công cụ đếm đúng nguyên mã, tính cả dự đoán dư/trùng và giữ nhãn chưa duyệt trong báo cáo. Không tính vị trí, không cộng kết quả bảng vào bản đồ, không lưu dữ liệu ảnh vào báo cáo. Các crop dùng lại giữa các thí nghiệm nên kết quả hiện là số đo phát triển, không phải kiểm chứng độc lập.

## Kiểm thử kỹ thuật

- Bộ kiểm tra chuẩn đạt **55 bài JavaScript** và **33 bài Python**, gồm ranh giới mã Unicode, không nhập nhằng D/Đ, hộp chữ xoay, góc dự phòng, kiểm tra mô hình Latin và cách đếm dự đoán trùng.
- Kiểm thử trình duyệt xác nhận đọc đúng các hàng `KĐ7-93`, `ĐLSH-173`, `KD7-93` và nhãn SVG có dấu; các mã giữ riêng biệt. Kiểm thử ảnh xem trước, khoanh vùng, hủy và đổi tọa độ vẫn đạt.
- Tiện ích MV3 thật + dịch vụ OCR thật đọc đúng `KĐ7-93` và `ĐLSH-173` trên canvas chữ rõ, khoảng 7,60 giây gồm nạp mô hình; lệch tâm kỳ vọng khoảng 3 pixel. Chạy `tests/extension_ocr_smoke.cjs --vietnamese` với đường dẫn Playwright/Chromium như tài liệu phát triển.
- Lượt hồi quy ASCII qua tiện ích thật vẫn đọc đúng `VN48-123`, `VX-002`, khoảng 2,83 giây khi mô hình đã nạp.

## Áp dụng

Dịch vụ trên máy này đã được khởi động lại với `languages: ["vi","en"]`, `recognitionModel: "latin_g2"`. Trong `chrome://extensions`, tải lại **Ping Location 0.3.0**, rồi F5 trang VHub. Nếu có cấu hình CSS cũ sai, thử lại chế độ tự nhận diện hoặc chọn đúng bảng Quản lý hotspot. Không cần bỏ dấu mã căn để công cụ nhận.
