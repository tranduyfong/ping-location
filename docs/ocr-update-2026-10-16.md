# Sửa nhận màn hình và OCR phản hồi quá lâu — 16/10/2026

## Nguyên nhân đã xác minh

- Bản trước yêu cầu đọc được các hàng **Chờ gắn** rồi mới cho quét. Vì vậy, thiếu bảng quản lý hoặc chưa nhận đúng hàng căn làm chức năng đọc bản đồ bị chặn dù ảnh vẫn chụp được.
- Mặc định cũ xoay cả ảnh lớn qua 6 hướng và phóng ảnh trước khi đọc. EasyOCR ghép các đoạn chữ có độ dài rất khác nhau trong cùng lượt nhận dạng, khiến nhãn nhỏ bị đệm theo chiều rộng của dòng chữ đường phố dài. Chi phí xử lý tăng mạnh.
- Giao diện cũ giữ một HTTP request tới khi có kết quả cuối. Khi hết thời gian chờ, công việc OCR phía Python vẫn có thể tiếp tục dùng CPU. Đã xác minh một tiến trình cũ còn giữ yêu cầu đang chạy trên cổng 8766, sau đó dừng đúng tiến trình của dịch vụ và khởi động bản mới.

## Thay đổi

1. **Kiểm tra màn hình** hiển thị ảnh và kích thước vùng đọc, dùng được khi bảng căn chưa mở hoặc kết nối điều khiển debugger chưa thành công.
2. **Khoanh vùng bản đồ** cho chọn một dãy căn; tọa độ OCR được đổi đúng về tọa độ màn hình. Các phần bản đồ nằm ngoài cửa sổ được cắt theo vùng thực sự nhìn thấy.
3. Đọc trực tiếp nhãn DOM/SVG khi có. VHub thực tế dùng `#krpanoSWFObject` và hai canvas; mã đã in trong ảnh vẫn cần OCR. Nhãn của các hotspot đã gắn được loại khỏi việc nhận diện căn chưa gắn.
4. **Tự động (nhanh)** ước lượng hướng chữ chính, giới hạn kích thước detector và tách nhóm nhận dạng theo chiều rộng. Chế độ kỹ dùng tile chồng lấn và nhiều góc.
5. API `/jobs` nhận việc nhanh; tiện ích lấy tiến độ khoảng 0,75 giây/lần. Có hủy tác vụ, báo lỗi dịch vụ cũ/offline và giới hạn thời gian. Backend kiểm tra lệnh hủy giữa các lượt và các nhóm nhận dạng.
6. Kết quả được cache trong RAM tối đa 8 mục / 64 MiB / 10 phút. Cache không giữ ảnh. Sau khi dừng, kết quả trả muộn không được ghi đè dữ liệu phiên.

## Kiểm chứng

- **54 bài kiểm tra JavaScript và 26 bài Python đạt**: mã căn, tọa độ, hủy, tiến độ, cache, HTTP, thao tác gắn và giới hạn lượt chạy.
- Kiểm tra trình duyệt: ảnh xem trước khi không có bảng quản lý; khoanh ROI 570 × 500; tiến độ OCR; đổi tọa độ điểm; hủy đang đọc; đọc chữ SVG không gọi OCR.
- Tiện ích MV3 thật với hồ sơ Chromium tạm vẫn gắn và xác nhận **5/5 căn mô phỏng**. Không sửa dữ liệu trên VHub đã đăng nhập.
- Kiểm tra trọn luồng bằng **tiện ích thật + dịch vụ OCR thật**, không giả lập HTTP: chụp canvas 800 × 300 khi không mở bảng quản lý, nhận 3 lần cập nhật tiến độ, đọc đúng `VN48-123` và `VX-002` trong khoảng **2,85 giây** khi mô hình đã nạp; điểm chữ lệch tâm kỳ vọng khoảng 2–3 pixel. Đây là mẫu chữ rõ, không đại diện độ chính xác trên bản đồ thật. Chạy lại bằng `node tests/extension_ocr_smoke.cjs`.
- Gọi API dịch vụ thật bằng ảnh nhãn rõ 800 × 300: đọc đúng `VN48-123`, `VX-002` trong **9,468 giây** gồm nạp mô hình; gửi lại cùng ảnh dùng cache. Báo cáo: `tmp/verify-jobs.json`.
- Ảnh người dùng 1.908 × 986: chế độ nhanh hoàn thành **22,431 giây** gồm nạp mô hình; vùng bản đồ 1.250 × 800 hoàn thành **19,682 giây** khi mô hình đã nạp. Báo cáo: `tmp/ocr-quick-benchmark.json`.

**Tốc độ không phải độ chính xác.** Trên ảnh người dùng, các mã nhìn thấy trong lần quét toàn ảnh nằm trong bảng quản lý; sau khi loại vùng này, chưa nhận được mã bản đồ đúng để tự gắn. Ảnh gốc có chữ nhỏ khoảng 8 pixel; cần phóng to bản đồ trực tiếp trên trang hoặc dùng điểm mẫu. Bản sửa xử lý lỗi bị chặn, thời gian chờ và chẩn đoán ảnh, chưa chứng minh độ chính xác trên mọi vùng VHub.

## Áp dụng bản sửa

1. `chrome://extensions` → **Ping Location → Tải lại**; phiên bản phải là **0.2.0**.
2. Quay về VHub, **F5**, rồi mở tiện ích lại.
3. **Kiểm tra màn hình → Khoanh vùng bản đồ → Tự động (nhanh) → Quét mã bằng OCR**.
4. Nếu còn lỗi, **Xuất nhật ký** để lấy mã lỗi, kích thước và vùng ảnh thực tế. Không cần chia sẻ cookie hoặc mật khẩu.

Nếu tự cập nhật ở lần khác, khởi động lại dịch vụ bằng `start.cmd` để nạp mã Python mới. Bản đang chạy trong phiên sửa này đã được khởi động lại và kiểm tra.
