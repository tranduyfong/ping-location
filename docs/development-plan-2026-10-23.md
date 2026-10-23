# Kiểm thử và phương án tăng nhận diện — 23/10/2026

## Kết quả chạy trên máy hiện tại

Đã dựng môi trường Python riêng tại `.venv`, cài `service/requirements.txt`, tải hai mô hình EasyOCR vào `.models/easyocr`. Node.js và Playwright Core đặt trong `tmp/runtime`; dùng Chromium 1243 đã có sẵn. Không dùng phiên đăng nhập VHub để thử gắn căn.

- OCR: `http://127.0.0.1:8766/health`, `ocrReady: true`, `jobsApi: 1`. Mô hình đã được nạp bằng lượt OCR thực tế.
- Demo: `http://127.0.0.1:8767`. Dịch vụ chỉ lắng nghe loopback.
- 54/54 kiểm thử JavaScript đạt; 26/26 kiểm thử Python đạt.
- `browser_smoke`: kiểm tra 24 lô, gắn 5 căn qua giao diện, dừng khi click sai.
- `extension_smoke`: tiện ích MV3 thật, quyền activeTab, chụp ảnh, click debugger, xác nhận 5 căn mô phỏng.
- `recognition_ui` và `adapter_map`: xem ảnh, khoanh vùng, tiến độ, hủy, đổi tọa độ, nhãn SVG và loại phần giao diện che bản đồ.
- `extension_ocr_smoke`: tiện ích thật gọi OCR thật, nhận đúng `VN48-123` và `VX-002` trên canvas chữ rõ. Khoảng **9,10 giây**, 11 cập nhật tiến độ, gồm nạp mô hình lạnh. Tâm nhãn trả về `(632,243)` và `(1032,357)`; lệch khoảng 3–4 pixel so với điểm kỳ vọng. Đây là tọa độ màn hình CSS.

Các kết quả trên kiểm chứng hoạt động phần mềm trên dữ liệu mô phỏng. **Chưa có số đo độ chính xác mới trên bản đồ thật của người dùng.** Báo cáo cũ 0/9 mã trong một vùng ảnh nhỏ là kết quả lịch sử ngày 16/10, chưa chạy lại vì ảnh đầu vào đó không có trong workspace hiện tại.

Đã sửa lỗi chờ trong helper kiểm thử JavaScript: 20 vòng `setImmediate` có thể kết thúc trước timer polling trên Windows. Helper giờ nhường cho timer chạy, có hạn chờ 2 giây. Không thay thuật toán OCR để làm đẹp kết quả. Script kiểm tra hỗ trợ Node portable trong `tmp/runtime` khi PATH chưa có Node. `.gitignore` bổ sung runtime, mô hình và dữ liệu riêng; tệp đã được Git theo dõi từ trước vẫn giữ nguyên trạng thái theo dõi.

## Điểm nghẽn cần xử lý

1. **Ảnh chữ quá nhỏ.** Chế độ quick giới hạn detector ở 1280 px, chỉ lấy hướng chữ chính. Khi quét vùng lớn, chi tiết nhãn có thể mất. Chế độ thorough có tile và nhiều hướng nhưng chưa được đo trên ảnh mới.
2. **Tâm chữ chưa phải điểm bấm an toàn.** Backend trả tâm hộp OCR; chưa tách đường bao từng lô. Mã đọc đúng vẫn có thể đưa điểm lên mép hoặc sang lô khác.
3. **Phản hồi chưa đủ để huấn luyện OCR.** Hiện có hai bản ghi chấm tay trong `service/.data/feedback.jsonl`, chỉ gồm mã, điểm CSS, trang và kích thước viewport. Không có ảnh, ID ảnh hay trạng thái zoom/pan đủ để gắn nhãn vào ảnh chính xác. `raw` đang trống trong hai bản ghi; thao tác chấm lại cũng chưa giữ dự đoán trước khi sửa. Lưu JSONL chưa làm thay đổi trọng số OCR.
4. **Chưa có tập kiểm chứng riêng.** Điểm confidence của OCR không phải tỷ lệ nhận diện thực tế. Tăng recall bằng hạ ngưỡng có thể làm tăng gắn nhầm.

## Cách dùng ảnh gốc hơn 100 MB

Đặt tệp gốc vào `C:\vhs-project\ping-location\data\` và cung cấp tên tệp. Giữ nguyên độ phân giải; chưa cần tải toàn bộ lên chat. Cần thêm một ảnh chụp màn hình VHub để đối chiếu ảnh gốc với bản đồ đang hiển thị.

API hiện giới hạn ảnh 12 MiB, mỗi cạnh 8192 px, tổng 20 triệu pixel; không gửi thẳng tệp lớn vào API. Bước phát triển tiếp là công cụ đọc ảnh cục bộ và cắt tile không giảm độ phân giải, chẳng hạn 1024–1536 px với phần chồng lấn. Kích thước tile cần đo trên dữ liệu thật. Nếu ảnh có số pixel quá lớn so với RAM, dùng bộ đọc theo vùng thay vì giải mã toàn ảnh; không tắt giới hạn ảnh lớn một cách mặc định.

Mỗi tile cần giữ SHA-256/ID ảnh nguồn, vị trí góc trái và kích thước để đổi tọa độ về ảnh gốc. Phải hợp nhất kết quả ở phần chồng lấn. Chỉ kiểm tra mã không đủ khi một mã xuất hiện ở nhiều vị trí.

**Tọa độ ảnh gốc không được nhập trực tiếp làm tọa độ click Chrome.** Cần bước căn chỉnh ảnh với viewport hiện tại, kiểm tra sai số bằng các mốc độc lập; kéo/zoom phải làm mất hiệu lực phép căn chỉnh cũ. Nếu bản đồ bị biến dạng theo cách hiển thị của viewer, cần căn chỉnh từng vùng hoặc truy cập phép chiếu của viewer khi có API phù hợp.

## Lộ trình đề xuất

### 1. Lập bộ mẫu và đo đường cơ sở

Bắt đầu bằng 30–50 lô do người dùng xác nhận, phủ chữ nhỏ/lớn, nhiều góc, màu nền, lô góc và vùng khó. Lưu ảnh nguồn cùng mã chuẩn, hộp chữ, điểm bấm chuẩn và đường bao lô nếu có. Đường bao cho phép kiểm tra điểm OCR có nằm trong đúng lô hay không. Đây là dữ liệu mới cần bổ sung; giao diện hiện tại chưa có công cụ vẽ đường bao và chưa lưu ảnh huấn luyện.

Lưu nhãn văn bản và điểm bấm riêng: điểm bên trong lô có thể cách xa nhãn chữ. Mỗi sửa đổi cần lưu dự đoán ban đầu, nhãn đã sửa, ảnh/tile ID, hệ tọa độ và phiên bản mô hình. Nếu triển khai lưu ảnh, cần tùy chọn lưu rõ ràng, dùng cục bộ và giới hạn dung lượng; hiện API vẫn giữ quy tắc không lưu ảnh.

Chia dữ liệu phát triển/kiểm chứng theo vùng hoặc dãy, để các tile chồng lấn và ảnh cùng lô không rơi vào cả hai tập. Giữ một nhóm chưa dùng để điều chỉnh, dành cho lần đánh giá cuối.

### 2. Cải thiện đọc mã bằng ảnh đủ nét

So sánh quick, thorough và góc chữ đã xác nhận trên cùng bộ mẫu. Chạy ảnh gốc theo tile; bổ sung lượt đọc crop chữ bị bỏ sót hoặc độ tin cậy thấp. Thử giới hạn bộ ký tự phù hợp và tham số ghép hộp như các thí nghiệm riêng, chỉ giữ thay đổi khi số đo cải thiện. EasyOCR có API `detect`, `recognize`, `allowlist` và `rotation_info`: [tài liệu chính thức](https://jaided.ai/easyocr/documentation/).

Danh sách mã hợp lệ giúp phát hiện lỗi và gợi ý sửa cho người duyệt; giữ nguyên số 0 đầu và không tự đổi O/0 rồi gắn. Không coi mã có trong danh sách là bằng chứng vị trí đúng.

### 3. Tìm điểm bên trong đúng lô

Ưu tiên tận dụng đường bao có sẵn trong dữ liệu gốc nếu có. Với ảnh raster, thử tách đường biên/vùng lô, gán nhãn chữ vào từng lô và chọn điểm phía trong có khoảng cách tốt tới đường biên. Lô hẹp, đường biên hở, nhiều nhãn hoặc một nhãn gần hai lô cần người duyệt. Đo thêm sai số căn chỉnh ảnh → màn hình trước khi cho click.

### 4. Học từ phản hồi của người dùng

Đưa các trường hợp bỏ sót, đọc sai, trùng mã, điểm sát biên và căn chỉnh kém vào hàng chờ duyệt. Kiểm tra ngẫu nhiên cả một phần kết quả confidence cao để phát hiện lỗi tự tin sai. Người dùng xác nhận mã, khoanh chữ và sửa điểm/đường bao; hệ thống lưu đúng cặp ảnh–nhãn.

Chỉ cân nhắc fine-tune nhận dạng chữ hoặc mô hình tách lô sau khi đã thấy loại lỗi nào còn chiếm ưu thế. Bộ 30–50 lô ban đầu dùng để đo và thiết kế quy trình; không đủ để cam kết huấn luyện đạt chất lượng. Mọi phiên bản mới phải vượt tập kiểm chứng riêng trước khi thay bản đang dùng.

## Số đo để quyết định thay đổi

| Số đo | Ý nghĩa |
|---|---|
| Precision mã | Số dự đoán đúng nguyên mã / tổng dự đoán; ghép một-một theo vị trí |
| Recall mã | Số nhãn chuẩn được tìm đúng / tổng nhãn chuẩn trong vùng |
| Điểm đúng lô | Tỷ lệ điểm nằm trong đường bao lô tương ứng, kèm khoảng cách tới biên |
| Thành công kết hợp | Đúng mã, đúng lô và đổi sang tọa độ màn hình đúng |
| Tỷ lệ cần duyệt | Bao nhiêu lô cần người xác nhận và thời gian duyệt |
| Thời gian | Trung vị và p95 mỗi vùng, tách nạp mô hình lạnh và cache |

Chốt ngưỡng tự động sau khi có số đo thực tế và mức chấp nhận gắn nhầm của người dùng. Ưu tiên giảm gắn sai trước khi tăng số lô tự chạy. Không dùng tỷ lệ trên hai nhãn tổng hợp làm cam kết trên VHub.

## Chạy lại trên máy này

```powershell
# Được kiểm thử với môi trường riêng và Node portable vừa cài.
.\scripts\check.cmd

# Khi khởi động lại máy: mở hai terminal riêng.
.\start.cmd
.\demo.cmd

# Kiểm thử OCR thật; dịch vụ phải đang rảnh.
.\tmp\runtime\node.exe tests\extension_ocr_smoke.cjs --playwright-path C:\vhs-project\ping-location\tmp\runtime\playwright-core\package --chrome-path C:\Users\Admin\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe
```

Trong Chrome, tải tiện ích giải nén từ `C:\vhs-project\ping-location\extension`, mở demo và bấm biểu tượng Ping Location. Thử nghiệm hiện tại dùng hồ sơ Chromium tạm, nên không cài vào hồ sơ Chrome cá nhân.
