# Cấp phát nước cất · Trường Dược

Ứng dụng web số hóa **Giấy đề nghị cấp nước cất** của Trường Dược, Đại học Y Dược TP.HCM.

Địa chỉ chạy: **https://cpnc.truongduoc.workers.dev** · Mã nguồn: **https://github.com/td-ship-it/cpnc**

```
Trình duyệt ──► Cloudflare Worker ──► Google Apps Script ──► Google Sheet
               (giao diện + /api)      (quy trình, email)     (dữ liệu)
```

## Quy trình: 3 chữ ký đồng ý như phiếu giấy

| Bước | Ai làm | Email tự động gửi tới |
|---|---|---|
| 1. Lập giấy đề nghị | Cán bộ bộ môn | **Trưởng bộ môn** của bộ môn đó |
| 2. Đồng ý (ký 1) | Trưởng bộ môn | **Trưởng phòng Quản trị Tổng hợp** |
| 3. Đồng ý (ký 2) | Trưởng phòng QTTH (có thể sửa số lít duyệt) | **Phó hiệu trưởng phụ trách** |
| 4. Đồng ý (ký 3) | Phó hiệu trưởng phụ trách | **Người phụ trách phát nước cất**, **Trưởng bộ môn**, **người đề nghị** (cùng lúc) |
| 5. Phát nước, trừ kho | Người phụ trách phát nước cất | Trưởng bộ môn, người đề nghị |

- **Trưởng bộ môn tự lập phiếu** cho bộ môn mình: chữ ký Trưởng bộ môn được ký luôn, phiếu chuyển thẳng tới Trưởng phòng QTTH.
- **Từ chối** ở bất kỳ bước nào: email báo người đề nghị và Trưởng bộ môn, kèm lý do.
- **Kho dưới ngưỡng**: email cảnh báo một lần tới Người phụ trách phát nước và Trưởng phòng QTTH để nhập thêm; tự đặt lại khi kho được bổ sung trên ngưỡng.
- Mỗi phiếu có **thanh tiến trình 5 bước** và mục "Diễn biến & email thông báo" ghi rõ ai đã ký, lúc nào, email đã gửi cho ai. Trang Tổng quan có bảng **"Phiếu đang ở bước nào"** đếm số phiếu ở từng bước.
- Email có nút **Mở phiếu**: người nhận bấm vào là tới thẳng phiếu (đăng nhập nếu cần).

## Vai trò

| Vai trò | Quyền |
|---|---|
| Cán bộ đề nghị | Lập phiếu, theo dõi, hủy phiếu của mình khi chưa duyệt xong |
| Trưởng bộ môn | Lập phiếu; đồng ý / từ chối phiếu **của bộ môn mình** |
| Trưởng phòng Quản trị Tổng hợp | Đồng ý / từ chối bước 3; nhập kho, kiểm kê |
| Phó hiệu trưởng phụ trách | Đồng ý / từ chối bước 4 |
| Phụ trách phát nước cất | Phát nước (bước 5); nhập kho, kiểm kê; nhận cảnh báo kho |
| Quản trị hệ thống *(thêm vào bất kỳ vai trò nào)* | Duyệt đăng ký, quản lý người dùng, bộ môn, thiết lập email và kho, xem nhật ký; duyệt thay khi một bước chưa có người phụ trách |

Mọi quyền được kiểm tra ở Apps Script, không chỉ ẩn nút trên giao diện.

---

## Hướng dẫn cài đặt từng bước

Cần chuẩn bị: một **tài khoản Google** (nên dùng tài khoản Google Workspace của trường để gửi được nhiều email hơn), một **tài khoản GitHub**, một **tài khoản Cloudflare** (gói miễn phí là đủ).

### Phần A. Google Sheet và Apps Script (khoảng 10 phút)

**A1. Tạo bảng tính**
1. Vào https://sheets.google.com → **Trống** (bảng tính mới).
2. Đặt tên, ví dụ `Cấp phát nước cất – dữ liệu`.

**A2. Dán mã máy chủ**
1. Trong bảng tính: **Tiện ích mở rộng → Apps Script**.
2. Xóa toàn bộ nội dung trong `Code.gs`.
3. Mở tệp `apps-script/Code.gs` trong bộ mã này, sao chép toàn bộ, dán vào. Bấm biểu tượng **Lưu** (đĩa mềm).
4. (Nên làm) Bấm **⚙ Cài đặt dự án** → tích **Hiển thị tệp kê khai "appsscript.json"** → quay lại **Trình chỉnh sửa**, mở `appsscript.json`, thay bằng nội dung tệp `apps-script/appsscript.json` → Lưu. Việc này đặt múi giờ Việt Nam.

**A3. Chạy `setup` để tạo dữ liệu và tài khoản admin**
1. Ở thanh công cụ, chọn hàm **`setup`** → bấm **▶ Chạy**.
2. Google hỏi quyền → **Xem xét quyền** → chọn tài khoản của bạn.
   Nếu thấy "Google chưa xác minh ứng dụng này": bấm **Nâng cao → Đi tới … (không an toàn)** → **Cho phép**. Script chỉ truy cập bảng tính của chính bạn và gửi email thay bạn.
3. Xem **Nhật ký thực thi** ở dưới, ghi lại dòng:
   ```
   ĐÃ TẠO TÀI KHOẢN QUẢN TRỊ → tên đăng nhập: admin · mật khẩu: XXXXXXXXXXXX
   ```
4. Quay lại bảng tính, sẽ thấy 6 trang tính: `Users`, `Departments`, `Requests`, `Stock`, `Config`, `Log`. **Không đổi tên trang tính, không đổi thứ tự cột.**

**A4. Cấp quyền gửi email**
1. Chọn hàm **`testMail`** → **▶ Chạy** (cấp quyền nếu được hỏi).
2. Kiểm tra hộp thư của bạn có email "[Nước cất] Kiểm tra gửi email". Nhật ký ghi số lượt gửi còn lại hôm nay.

**A5. Triển khai thành ứng dụng web**
1. Bấm **Triển khai → Tùy chọn triển khai mới**.
2. Bấm ⚙ cạnh "Chọn loại" → **Ứng dụng web**.
3. Điền:
   - Mô tả: `v1`
   - Thực thi dưới dạng: **Tôi (email của bạn)**
   - Người có quyền truy cập: **Bất kỳ ai**
4. Bấm **Triển khai** → sao chép **URL ứng dụng web** (dạng `https://script.google.com/macros/s/AKfy…/exec`). Lưu lại để dùng ở Phần C.

> "Bất kỳ ai" là bắt buộc để Cloudflare gọi được. Đăng nhập và phân quyền do ứng dụng xử lý; bảng tính vẫn riêng tư.

### Phần B. Đưa mã lên GitHub (khoảng 5 phút)

**Cách dễ nhất, không cần dòng lệnh:**
1. Mở repository **https://github.com/td-ship-it/cpnc** (đã tạo sẵn).
2. Bấm **Add file → Upload files** (repository trống thì bấm **uploading an existing file**).
3. Giải nén tệp zip, kéo **toàn bộ nội dung bên trong thư mục** `nuoc-cat-cf` (gồm `public`, `src`, `apps-script`, `wrangler.jsonc`, `package.json`, …) vào trang. Không kéo cả thư mục cha.
4. Bấm **Commit changes**.

**Hoặc dùng dòng lệnh:**
```bash
cd nuoc-cat-cf
git init && git add . && git commit -m "Cấp phát nước cất"
git branch -M main
git remote add origin https://github.com/td-ship-it/cpnc.git
git push -u origin main
```

### Phần C. Triển khai lên Cloudflare Workers (khoảng 5 phút)

1. Đăng nhập https://dash.cloudflare.com → **Workers & Pages** → **Create** → tab **Workers** → **Import a repository**.
2. Kết nối GitHub (lần đầu sẽ được hỏi cấp quyền) → chọn repository `td-ship-it/cpnc`.
3. Màn hình cấu hình, giữ nguyên:
   - Project name: `cpnc` (phải đúng tên này để có địa chỉ `cpnc.truongduoc.workers.dev`)
   - Build command: *(để trống)*
   - Deploy command: `npx wrangler deploy`
   - Root directory: `/`
4. Bấm **Create and deploy**, chờ khoảng 1 phút.
5. Vào Worker vừa tạo → **Settings → Variables and Secrets → + Add**:
   - Type: **Secret**
   - Variable name: `APPS_SCRIPT_URL`
   - Value: URL `/exec` ở bước A5
   
   Bấm **Deploy**.
6. Kiểm tra: mở `https://cpnc.truongduoc.workers.dev/api/health`. Phải thấy
   `{"ok":true,"worker":"ok","appsScript":"ok"}`.
   - `config`: chưa đặt hoặc đặt sai `APPS_SCRIPT_URL`.
   - `upstream`: kiểm tra lại bước A5 (phải là "Bất kỳ ai", URL kết thúc bằng `/exec`).
7. (Tùy chọn) Gắn tên miền riêng: Worker → **Settings → Domains & Routes → + Add → Custom domain**.

Từ nay, mỗi lần sửa mã và đẩy lên GitHub, Cloudflare tự triển khai lại.

### Phần D. Thiết lập ban đầu trong ứng dụng (khoảng 10 phút)

1. Mở địa chỉ trang, đăng nhập `admin` với mật khẩu ở bước A3.
2. Bấm **Tài khoản** (đầu trang): kiểm tra email (đã điền sẵn email chủ bảng tính), **đổi mật khẩu**.
3. **Quản trị hệ thống → Thiết lập & email**:
   - Ô **Địa chỉ trang**: để như đề xuất (chính địa chỉ đang mở) → **Lưu**. Địa chỉ này dùng cho nút "Mở phiếu" trong email.
   - Bấm **Gửi email thử tới tôi** để kiểm tra.
   - Đặt **Ngưỡng cần đặt thêm** và **Dung tích kho** → **Lưu**.
4. **Quản trị hệ thống → Bộ môn**: thêm từng bộ môn.
5. **Quản trị hệ thống → Người dùng → + Thêm người dùng**, tạo tối thiểu:
   - 1 **Trưởng phòng Quản trị Tổng hợp**
   - 1 **Phó hiệu trưởng phụ trách**
   - 1 **Phụ trách phát nước cất**
   - Mỗi bộ môn 1 **Trưởng bộ môn** (bắt buộc chọn bộ môn)
   
   Nhập đúng **email** cho từng người. Hệ thống hiện **mật khẩu tạm**; gửi cho người đó qua kênh riêng. Trang sẽ cảnh báo nếu còn thiếu vai trò hoặc thiếu email.
6. Cán bộ bộ môn có thể tự **Đăng ký** ở trang chủ; bạn duyệt trong **Yêu cầu đăng ký** (chọn vai trò, bộ môn). Người dùng nhận email khi được duyệt.
7. Người phụ trách phát nước đăng nhập → **Sổ kho → Kiểm kê** → nhập số lít đang có làm tồn đầu kỳ.

### Phần E. Chạy thử một phiếu

1. Cán bộ bộ môn đăng nhập → **+ Lập giấy đề nghị** → nhập số lít, mục đích → **Gửi đề nghị**. Trưởng bộ môn nhận email.
2. Trưởng bộ môn bấm **Mở phiếu** trong email (hoặc vào **Cần bạn xử lý**) → **Đồng ý**. Trưởng phòng QTTH nhận email.
3. Trưởng phòng QTTH → sửa số lít duyệt nếu cần → **Đồng ý**. Phó hiệu trưởng nhận email.
4. Phó hiệu trưởng → **Đồng ý**. Người phát nước, Trưởng bộ môn, người đề nghị nhận email.
5. Người phát nước → nhập số lít thực phát → **Xác nhận đã phát**. Kho tự trừ; bộ môn nhận email.
6. Bấm **Xem giấy đề nghị → In phiếu** để in bản có 3 dấu đồng ý.

---

## Cập nhật phiên bản

- **Giao diện / Worker** (`public/`, `src/`): sửa rồi đẩy lên GitHub, Cloudflare tự triển khai.
- **Apps Script** (`Code.gs`): dán bản mới → Lưu → chạy lại **`setup`** (an toàn, chỉ bổ sung cột mới) → **Triển khai → Quản lý các bản triển khai → ✏ → Phiên bản: Phiên bản mới → Triển khai**. URL giữ nguyên.
  Nếu lỡ tạo *bản triển khai mới*, URL đổi; cập nhật lại secret `APPS_SCRIPT_URL` trên Cloudflare.

## Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| Trang báo "Chưa cấu hình máy chủ" | Đặt secret `APPS_SCRIPT_URL` trên Cloudflare (C5) |
| Không nhận được email | Kiểm tra email người dùng ở **Người dùng**; mục **Nhật ký** có dòng "✉ Lỗi gửi email"; chạy lại `testMail`; có thể đã hết hạn mức trong ngày |
| Email không có nút "Mở phiếu" | Lưu **Địa chỉ trang** ở **Thiết lập & email** |
| Phiếu kẹt ở một bước | Chưa có người giữ vai trò đó (hoặc chưa có Trưởng bộ môn cho bộ môn). Gán vai trò, hoặc Quản trị hệ thống mở phiếu và đồng ý thay |
| Quên mật khẩu admin | Apps Script → chạy hàm **`resetAdminPassword`** → xem mật khẩu mới trong nhật ký |
| Người dùng quên mật khẩu | Quản trị hệ thống → **Người dùng → Đặt lại mật khẩu** |

## Giới hạn cần biết

- Email gửi từ tài khoản Google triển khai Apps Script: Gmail thường khoảng **100 người nhận/ngày**, Google Workspace khoảng **1.500/ngày**. Mỗi phiếu đi hết quy trình dùng khoảng 8 lượt.
- Mỗi thao tác mất 1–3 giây (Apps Script); trang chủ công khai có thể trễ tới khoảng 30 giây so với sổ kho.
- **Không chia sẻ Google Sheet** cho người không phải quản trị.

## Cấu trúc thư mục

```
├── wrangler.jsonc        Cấu hình Cloudflare Worker
├── package.json          Lệnh dev/deploy (wrangler)
├── .dev.vars.example     Mẫu biến môi trường khi chạy thử trên máy (npm run dev)
├── src/worker.js         Worker: phục vụ trang + chuyển tiếp /api tới Apps Script
├── public/               Giao diện
│   ├── index.html
│   ├── _headers          Header bảo mật
│   └── assets/ (style.css, app.js)
└── apps-script/
    ├── Code.gs           Máy chủ: quy trình, email, phân quyền
    └── appsscript.json
```
