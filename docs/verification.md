# Kiểm chứng bản đầu tiên — 16/10/2026

## Phạm vi thực tế

Đã triển khai tiện ích Chrome và dịch vụ OCR cục bộ. Đã đọc HTML/bundle JavaScript công khai của trang VHub để đối chiếu cấu trúc hàng căn, nút Gắn, phân trang và tên hotspot ứng dụng. Không truy cập phiên đăng nhập của người dùng; không gắn hay sửa căn trên VHub thật trong quá trình phát triển.

## Những luồng đã kiểm tra

- Mã được đối chiếu nguyên vẹn, giữ tiền tố, dấu chấm và số 0 đầu; tọa độ trùng xa nhau hoặc nằm trên bảng quản lý bị chặn.
- Nội suy dãy chẵn/lẻ phải có ít nhất 3 mẫu cùng dãy, không ngoại suy hoặc tự duyệt điểm suy ra.
- Hủy trong lúc kiểm tra tab, kết nối debugger hoặc chờ ảnh không cho phép các lệnh bấm tiếp theo; lượt cũ phải hoàn tất dọn dẹp trước khi chạy lượt mới.
- HTTP OCR kiểm tra dữ liệu, Origin, Host, dung lượng và phép đổi tọa độ từ ảnh xoay về ảnh gốc.
- Trình duyệt Chrome headless: trang giả có 24 lô; từng điểm tâm đều bấm được và xác nhận đúng. Click sai, mã chỉ khớp một phần, thông báo cũ và thông báo thất bại không được tính là gắn thành công. Có kiểm tra phân trang và nút Sau ở trang cuối.
- Luồng giao diện: đọc danh sách → chấm 5 điểm → tự gắn 5 căn → xác nhận 5 lần → đóng phiên điều khiển. Chạy với click sai dừng lại, giữ nguyên 24 căn chờ gắn và không ghi nhận thành công.
- Tiện ích MV3 thật trong Chromium với hồ sơ tạm: bấm biểu tượng tiện ích để cấp `activeTab`, chụp bằng `captureVisibleTab`, bấm bằng `chrome.debugger`, xác nhận đủ 5/5 căn; số căn chờ gắn từ 24 còn 19. Không có lỗi JavaScript trình duyệt.
- Đã phát hiện và sửa việc thanh thông báo debugger thay đổi kích thước vùng nhìn: kết nối trước khi đo bản đồ, và kiểm tra lại kích thước ngay trước lệnh chuột. Tọa độ ở khung nhìn cũ không được bấm.

Bài kiểm thử giao diện thông thường sử dụng API Chrome giả lập; bài `extension_smoke` kiểm tra thêm tiện ích MV3 thật. Bộ kiểm tra JavaScript có 34 bài và dịch vụ Python có 16 bài đều đạt. Python còn kiểm tra 80 phản hồi từ chối POST lặp lại để xác nhận đã sửa lỗi Windows đóng kết nối trước khi nhận được thông báo lỗi. Các thử nghiệm trên trang giả chưa chứng minh luồng gắn hoạt động trên phiên VHub đã đăng nhập.

## OCR trên ảnh người dùng

Ảnh: `b077711d-dd33-4885-be92-76218ef816fa.jpg`. Vùng thử `[930,285,1180,590]` chứa 9 mã đọc thủ công từ `VN50-01` đến `VN50-09`.

Chạy EasyOCR cục bộ với góc 330°, phóng 3 lần và ngưỡng 0,3: **0 mã được nhận đúng trong vùng thử**, khoảng 14,73 giây gồm nạp mô hình. Các thử nghiệm xoay, phóng và lọc mực xanh chưa giải quyết được chữ nhỏ/mờ. Không dùng kết quả này để khẳng định tỷ lệ nhận diện toàn bản đồ.

Mẫu tổng hợp dùng chữ Arial 32 px: đọc đúng `VN48-123` và `VX-002`, điểm mô hình khoảng 0,9999 và 0,9799. Kết quả này xác nhận mô hình có hoạt động, không đại diện độ chính xác trên ảnh bản đồ.

Khi dùng thật, cần phóng to **bản đồ đang mở trên trang** để lấy thêm chi tiết, hoặc chấm các điểm mẫu. Phóng to ảnh chụp cũ không phục hồi chi tiết đã mất. Các căn đủ điều kiện có thể chạy tự động; việc quét toàn bộ bản đồ lớn bằng cách tự di chuyển/thu phóng chưa được triển khai.

## Chạy lại

```powershell
.\scripts\check.cmd
node tests/browser_smoke.cjs
node tests/extension_smoke.cjs
python -m service.tools.smoke "C:\Users\ThinkPad\Downloads\b077711d-dd33-4885-be92-76218ef816fa.jpg" --crop 930 285 1180 590 --angles 330 --scale 3 --expected VN50-01 VN50-02 VN50-03 VN50-04 VN50-05 VN50-06 VN50-07 VN50-08 VN50-09
```

Kết quả OCR dạng JSON ở `tmp/ocr-smoke-report.json` khi chạy lệnh có `--output` tương ứng; báo cáo không giữ ảnh. Xem thêm tùy chọn `python -m service.tools.smoke --help`.
