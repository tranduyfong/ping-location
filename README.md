# Ping Location

Tiện ích Chrome hỗ trợ thao tác **chọn căn trong Quản lý hotspot → Gắn → bấm đúng vị trí → kiểm tra kết quả**. Dự án nằm riêng trong thư mục `ping-location`, không thay đổi các dự án bên cạnh.

[Xem giao diện minh họa](docs/ping-location-preview.png) · [Kết quả kiểm chứng và giới hạn OCR](docs/verification.md).

## Cài và chạy

1. Chạy `start.cmd`, giữ cửa sổ đó mở. Máy hiện tại đã có thư viện OCR và mô hình trong dự án bên cạnh; dịch vụ tự tìm mô hình cục bộ. Bấm **Kiểm tra OCR** trong tiện ích để xem mô hình đã sẵn sàng chưa.
2. Trong Chrome, mở `chrome://extensions`, bật **Developer mode / Chế độ nhà phát triển** → **Load unpacked / Tải tiện ích đã giải nén** → chọn **`D:\vhs-project\ping-location\extension`**.
3. Mở [trang dự án VHub](https://vhub.com.vn/du-an/vinhomes-green-paradise/mat-bang-quy-can), đăng nhập như bình thường. Mở **Quản lý hotspot → Sản phẩm → Chờ gắn**, rồi bấm biểu tượng tiện ích **Ping Location** trên thanh Chrome.
4. Bấm **Đọc danh sách căn**. Tiện ích tìm bảng quản lý, từng hàng và nút **Gắn**. Nếu chưa tìm đúng, mở **Kết nối với trang**, dùng nút **⌖** để chọn thành phần trên trang rồi **Lưu cấu hình trang**. Có thể sửa trực tiếp bộ chọn CSS. Esc hủy chọn.
5. Phóng to bản đồ để đọc rõ mã, bấm **Quét mã bằng OCR**. Các điểm dự kiến hiện trên bản đồ: xanh là sẵn sàng, cam là cần duyệt. Kiểm tra kế hoạch, sửa bằng **Chấm lại** nếu cần. Sau đó bấm **Bắt đầu tự động**.

Khi đọc danh sách, tiện ích kết nối điều khiển trước khi lấy tọa độ. Chrome hiện thanh báo do tiện ích dùng quyền `debugger` để bấm thật vào bản đồ canvas/WebGL; công cụ đợi vùng hiển thị ổn định rồi mới nhận diện. Trong lúc chạy, giữ tab bản đồ ở phía trước. **Dừng**, **Esc**, hoặc **Ctrl+Shift+X** dừng phiên. Sau khi dừng, kiểm tra căn vừa thao tác vì thao tác đã gửi có thể đang được trang lưu.

Mặc định công cụ tự chuyển trang danh sách bằng nút **Sau**, tiếp tục gắn những mã đã có vị trí trên vùng bản đồ hiện tại; các căn chưa tìm thấy được giữ lại. Có thể tắt ô **Tự chuyển trang danh sách** để chỉ chạy nhóm đã chọn. Mỗi lượt giới hạn 100 trang / 500 căn. Khi kéo, thu phóng hoặc đổi kích thước cửa sổ, vị trí cũ bị đánh dấu cần quét lại.

## Học từ điểm mẫu

Không cần huấn luyện mô hình mới để bắt đầu:

- Bấm **Chấm căn mẫu**, nhập mã đầy đủ, rồi bấm vào **bên trong** lô tương ứng. Điểm đó được xác nhận thủ công và dùng ngay trong phiên.
- Với dãy thẳng, chấm ít nhất **3 căn cùng tiền tố**, gồm hai đầu và một điểm ở giữa. Nhập mã bắt đầu, mã kết thúc và bước số **1** hoặc **2**. Công cụ chỉ nội suy giữa các mẫu, kiểm tra độ thẳng/khoảng cách, giữ nguyên số 0 đầu và tạo các vị trí cần duyệt.
- **Duyệt** từng điểm nội suy sau khi đối chiếu trên bản đồ. Dãy cong, lô góc hoặc khoảng cách thay đổi nên chia thành đoạn ngắn hoặc chấm riêng.
- Mẫu sửa/duyệt được lưu cục bộ vào `service/.data/feedback.jsonl` khi dịch vụ đang chạy. Đây là dữ liệu nhãn để đối chiếu và phát triển tiếp; phiên bản này **chưa tự huấn luyện lại trọng số OCR**. Nội suy sử dụng các điểm mẫu đang có trong phiên.

Mã như `VN48-123`, `ASP-233`, `VX-002`, `VNB.TP.1-345` được đối chiếu nguyên mã. `VX-02` và `VX-002` là hai mã khác nhau. Không tự sửa `O` thành `0`, không tự gán căn chỉ theo màu hoặc vị trí hàng trong danh sách.

## Những gì tự động và giới hạn hiện tại

OCR đọc ảnh vùng bản đồ theo nhiều góc; kết quả có mã khớp chính xác, duy nhất và đủ ngưỡng sẽ vào danh sách sẵn sàng. Sau khi bạn bắt đầu, công cụ lần lượt bấm **Gắn**, bấm tọa độ và đợi bằng chứng kết quả. Không tìm thấy mã, mã trùng ở nhiều vị trí, điểm nằm trên bảng quản lý hoặc ngoài vùng nhìn sẽ được để lại. Nếu chưa xác nhận được một thao tác thì cả lượt dừng, không tự bấm lại.

**Đây là bản triển khai đầu tiên cho vùng bản đồ đang hiển thị.** Công cụ tự duyệt các trang danh sách từ trang hiện tại khi có nút **Sau**, nhưng chưa tự kéo/thu phóng để quét toàn bộ bản đồ lớn. Chưa kiểm chứng luồng lưu trên phiên VHub đã đăng nhập của bạn; mã công khai của trang được dùng để xây adapter, còn kiểm thử thao tác được chạy trên trang mô phỏng. Cấu trúc giao diện thực tế thay đổi có thể cần cấu hình lại các bộ chọn.

Ảnh chụp có nhãn nhỏ/xoay không đủ để cam kết độ chính xác toàn bản đồ. Ngưỡng OCR là điểm của mô hình, **không phải tỷ lệ chính xác đã đo**. Hãy phóng to chữ và chạy thử một nhóm nhỏ; có thể chọn căn nào được chạy bằng ô chọn. Các mẫu chấm và nhập tệp đều gắn với vùng nhìn hiện tại. Tệp nhập luôn cần duyệt lại.

## Chạy thử không tác động VHub

Chạy `demo.cmd`, mở **http://127.0.0.1:8767** trong Chrome rồi bật tiện ích. Trang mô phỏng có 24 lô nhiều màu, chữ xoay, nhiều dạng mã, dãy chẵn/lẻ và danh sách phân trang. Có thể thử chấm mẫu, gắn tự động và nút dừng. Đây là dữ liệu giả để kiểm tra hoạt động.

## Dữ liệu và cấu hình

- Ảnh được gửi từ tiện ích tới dịch vụ **`127.0.0.1:8766` trên máy này**. Dịch vụ OCR không gửi ảnh tới dịch vụ AI bên ngoài và không ghi ảnh nhận vào ra đĩa.
- Bộ chọn được lưu trong bộ nhớ tiện ích theo tên miền và đường dẫn trang; không thu thập mật khẩu hay cookie đăng nhập.
- **Xuất phiên làm việc** tải mã, tọa độ và nhật ký JSON; **Xuất nhật ký** chỉ tải lịch sử thao tác. Nhập JSON/CSV hỗ trợ cột `code,x,y,confidence`; ví dụ [coordinates.csv](examples/coordinates.csv). Tọa độ là pixel CSS của vùng hiển thị trình duyệt, không phải tọa độ bản đồ toàn cục.
- Khi đóng/tải lại trang, danh sách đang nhận diện cần quét hoặc nhập lại; cấu hình bộ chọn vẫn được giữ. Nhập lại phiên làm việc vẫn yêu cầu duyệt vị trí trong vùng nhìn mới.

## Cài trên máy khác

Yêu cầu Python 3.10+ và Chrome 118+. Từ thư mục `ping-location`:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r service/requirements.txt
.\.venv\Scripts\python.exe -m service --download-models
```

Lệnh cuối tải mô hình EasyOCR lần đầu, cần Internet. Những lần sau chạy `start.cmd`; chế độ bình thường không tự tải mô hình. Có thể chỉ định thư mục mô hình bằng `--model-dir`. Chi tiết API ở [service/README.md](service/README.md).

## Kiểm tra kỹ thuật

```powershell
.\scripts\check.cmd
```

Kiểm tra cú pháp JavaScript, đối chiếu mã/tọa độ/nội suy/CSV, hủy thao tác đang chờ trong Chrome, HTTP OCR, giới hạn dữ liệu, CORS và phép đổi tọa độ khi xoay ảnh. Bài kiểm thử trình duyệt sử dụng Chrome headless với hồ sơ tạm riêng, không dùng phiên đăng nhập VHub.

```powershell
node tests/browser_smoke.cjs
node tests/extension_smoke.cjs
```

Các bài trình duyệt dùng gói Playwright Core đã có trong workspace; máy khác có thể truyền `--playwright-path <thư-mục-package>` và `--chrome-path <chrome.exe>`. Không tự tải gói hay trình duyệt. `browser_smoke` kiểm tra 24 lô mô phỏng, phân trang, từ chối click sai, dấu hiệu lưu mới theo đúng mã và 5 lần gắn qua giao diện với API Chrome giả lập. `extension_smoke` tải tiện ích MV3 thật trong Chromium bằng hồ sơ tạm, kiểm tra toàn bộ luồng gắn 5 căn với quyền `activeTab`, chụp tab và lệnh chuột thật của `chrome.debugger`; dùng Chromium hỗ trợ nạp tiện ích bằng dòng lệnh.
