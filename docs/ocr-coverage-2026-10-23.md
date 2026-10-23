# Cải thiện độ phủ OCR và lỗi tiền tố VI/YT — 0.4.0

## Vấn đề trong ảnh người dùng

Ảnh thử một dự án khác có nhiều mã `VT39-...`, nhưng tiện ích báo ba ứng viên như `VI39-11`, `VI39-07`, `YT39-17`. Các nhãn xoay theo đường cong; giao diện đang chọn Ngang/dọc và ngưỡng 1.

Đây là hai vấn đề riêng: OCR đọc nhầm ký tự và quét bỏ sót. Ngưỡng 1 chỉ giới hạn tự gắn, không sửa chữ OCR hoặc tăng độ phủ. Ảnh VT39 hiện được cung cấp trong chat, chưa có tệp tương ứng trong workspace để chạy lại chính xác bằng dịch vụ. Các phép đo mới bên dưới dùng ảnh gốc đã có trên máy; không coi đó là độ chính xác đã đo trên VT39.

## Thay đổi đã triển khai

1. **Quét theo vùng để giữ độ nét.** Chế độ mới `balanced` chia ảnh thành tile 900 px chồng 100 px, mặc định scale 1,5, detector tối đa 1600 px. Tránh thu cả vùng bản đồ lớn về detector 1280 px như chế độ nhanh. Tiện ích mặc định Tự động (giữ độ nét); Ngang/dọc và Ngang cũng giữ độ nét. Quét nhanh vẫn có thể chọn riêng; Quét kỹ nhiều hướng giữ cách xử lý kỹ hơn trước đây.
2. **Đối chiếu tiền tố theo từng bản đồ.** Dùng tiền tố trong danh sách Chờ gắn hoặc ô Tiền tố cần đối chiếu do người dùng nhập. Không cố định VT39 trong thuật toán. Ví dụ với tiền tố VT39, VI39-011 có thể được gợi ý thành VT39-011 khi chỉ có một tiền tố phù hợp cách một ký tự. Giữ nguyên phần số và số 0 đầu; nhiều lựa chọn thì không đoán.
3. **Gợi ý luôn cần duyệt.** Giữ `originalCode`, hiện `VT39-11 ← VI39-11 (cần duyệt)`, điểm màu cam và lý do trên kế hoạch. Không thay OCR sai thành kết quả tự động chắc chắn. Tiền tố VI39 có thật trong danh sách vẫn được giữ riêng. Mẫu thủ công/DOM/nhập tệp không bị tự sửa tiền tố.
4. **Tên ngưỡng rõ nghĩa hơn.** Đổi Ngưỡng OCR thành Ngưỡng tự gắn, bổ sung giải thích. Màn hình báo số ứng viên và số cần duyệt. Khi duyệt một gợi ý, phản hồi lưu được mã gốc để đối chiếu sau này.

## Đo trên cùng một vùng ảnh gốc

Ảnh `TMB-2.jpg`, crop gốc `[17700,13700,18900,15300]`, kích thước 1200 × 1600. Cả hai lượt dùng góc 0° và ngưỡng nhận 0,25; không dùng gợi ý sửa tiền tố để tính số đúng.

| Cấu hình | Ứng viên | Tìm thấy trong nhóm sáu mã đã được người dùng xác nhận | Thời gian |
|---|---:|---:|---:|
| Quick, toàn vùng | 0 | 0/6 | 12,23 giây |
| Balanced, tile + scale 1,5 | 8 | 5/6 | 23,39 giây |

Năm mã chuẩn tìm được là VM2-23, VM2-25, VM2-27, VM2-29, VM2-33; còn thiếu VM2-31. Ngoài nhóm chuẩn còn có VM2-35/37 và một ứng viên sai tiền tố NM3-03. **Không coi cả tám ứng viên là tám kết quả đúng.** Nhóm sáu mã chỉ là một phần của vùng lớn này, nên không suy ra precision toàn vùng hoặc tỷ lệ cho toàn dự án từ phép đo đó. Lượt quick có nạp mô hình lạnh, balanced dùng mô hình đã nạp; thời gian mang tính tham khảo.

Thử cấu hình scale 2/detector 2400 trên vùng này tìm được 14 ứng viên và đủ sáu mã chuẩn, nhưng mất khoảng 87,89 giây; không dùng cấu hình đó làm mặc định mới. Các thử nghiệm tách dòng, lọc màu và tăng tương phản chưa cho lợi ích ổn định nên không đưa vào bản chạy.

Báo cáo cục bộ: `tmp/coverage-comparison-final.json`. Kết quả là số đo phát triển trên mẫu đã dùng điều chỉnh, chưa phải tập kiểm chứng độc lập. Chưa xác nhận độ chính xác điểm bấm theo đường bao lô.

## Kiểm thử

- **58 kiểm thử JavaScript, 34 kiểm thử Python đạt**: giữ số 0, không nhập nhằng tiền tố, không tự sửa mã thủ công, không tự duyệt gợi ý, tile/scale/canvas của balanced và các kiểm tra hủy/HTTP trước đó.
- Kiểm thử trình duyệt thật với OCR mô phỏng: nhập VT39, nhận VI39/YT39, hiện hai gợi ý với hai điểm màu cam; giữ nguyên mã gốc. Ảnh xem trước, ROI, hủy và đọc SVG vẫn đạt.
- Tiện ích MV3 thật + OCR thật với chế độ mặc định mới vẫn đọc đúng KĐ7-93 và ĐLSH-173 trên canvas chữ rõ, khoảng 8,37 giây gồm nạp mô hình. Đây là kiểm tra hoạt động, không đại diện bản đồ VT39.

## Cách thử lại

1. Trong `chrome://extensions`, tải lại Ping Location **0.4.0**, rồi F5 trang bản đồ. Dịch vụ trên máy này đã được khởi động lại, `/health.profiles` có `balanced`.
2. Chọn Tự động (giữ độ nét), khoanh một vùng nhỏ quanh dãy muốn đọc. Với nhãn theo đường cong, Ngang/dọc chỉ thử hai hướng; có thể dùng Quét kỹ nhiều hướng cho vùng nhỏ nếu còn bỏ sót.
3. Đọc danh sách Chờ gắn để lấy tiền tố đối chiếu. Nếu chưa đọc được danh sách, nhập tiền tố của dãy vào ô mới, chẳng hạn VT39; để trống khi chưa biết chắc.
4. Đối chiếu mã gốc, mã gợi ý và điểm màu cam trước khi duyệt. Tăng ngưỡng tự gắn không phải cách sửa mã sai.

Máy khác cần khởi động lại dịch vụ sau khi cập nhật, vì backend cũ chưa nhận `profile: balanced`. Ảnh gốc và bộ nhãn người dùng trước đó được giữ nguyên.
