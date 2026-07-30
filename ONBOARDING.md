# AI Support Theme — Hướng dẫn sử dụng cho team

Project này dùng Claude Code để tự động build/reconfigure 1 theme Shopify dựa trên thiết kế Figma,
và để tự động kiểm tra 1 theme đã có sẵn so với Figma. Đây là **2 việc tách biệt hoàn toàn**:

- **Auto-setup** (build/reconfigure từ Figma) — trigger bằng `Setup: ...`, chi tiết ở `CLAUDE.md`.
- **Auto-test** (kiểm tra theme đã có sẵn, log kết quả vào Google Sheet) — trigger bằng `Test: ...`,
  chi tiết ở `AUTOTEST.md`. Không config gì cả, chỉ chụp ảnh/so sánh/báo cáo.

File này là bản tóm tắt đơn giản cho **Auto-setup** (phần việc chính) để bất kỳ ai trong team cũng
dùng được ngay — chi tiết đầy đủ từng rule/edge-case nằm ở `CLAUDE.md` (Claude tự đọc file đó,
người dùng không cần đọc để dùng). Xem mục 7 bên dưới để biết thêm về `AUTOTEST.md`.

## 1. Kiến trúc / luồng xử lý

```
Nhận yêu cầu (store + theme id + link Figma)
        │
        ▼
Pull theme về máy (nếu chưa có)      → theme/<store>/<themeId>/
        │
        ▼
Đọc cấu trúc Figma file              → General Config / Template (các page) / Header-Footer / Overlay
        │
        ▼
Config chung TRƯỚC (1 lần, dùng cho mọi page)
  - Colors, Typography, Product card, theme_mode_enabled
        │
        ▼
Với MỖI section trong từng page (lặp lại cho tới hết):
  1. Đọc Figma JSON (nội dung: text, ảnh, màu...)      ─┐
  2. Đọc ảnh PNG render của section (layout: cột,        │ 2 nguồn dữ liệu,
     carousel, alignment...)                             │ luôn dùng cùng lúc
  3. Đọc schema section (2 bước: xem có block gì → chỉ  ─┘
     lấy chi tiết field của block thực sự cần dùng)
  4. Nếu có field "Custom icon (SVG)" → fetch icon thật từ Figma, không đoán icon có sẵn
  5. Ghép lại thành config (settings + blocks)
        │
        ▼
Ghi vào template JSON (không sửa tay, luôn qua script để tự kiểm tra lỗi)
        │
        ▼
Validate (kiểm tra type/field còn sai không)
        │
        ▼
Push từng phần vừa xong lên Shopify ngay (không đợi xong hết mới push)
        │
        ▼
Báo cáo: section nào dùng file nào, cái gì còn thiếu (ảnh cần merchant tự upload, sản phẩm/collection
chưa gán được, v.v.)
```

## 2. 2 chế độ chạy (chỉ dùng 1 trong 2, không trộn)

| | Khi nào dùng | Ai/cái gì thực thi |
|---|---|---|
| **Mode 1** | Có `ANTHROPIC_API_KEY` | `npm start` chạy server tự động, không cần mở Claude Code |
| **Mode 2** | Không có API key (team đang dùng) | Mở Claude Code, tự gõ yêu cầu, Claude làm toàn bộ bằng tay qua các script |

## 3. Cách dùng (Mode 2 — dùng Claude Code)

**Bước 1 — Mở Claude Code trong thư mục project này.**

**Bước 2 — Gõ yêu cầu theo 1 trong 2 dạng sau** (không cần đúng từng chữ, chỉ cần đủ thông tin):

```
setup theme <ten-store>.myshopify.com theme <themeId>
figma: https://www.figma.com/design/<fileKey>/<ten-file>?node-id=...
```

hoặc dùng link editor admin có sẵn:

```
Setup: https://admin.shopify.com/store/<handle>/themes/<themeId>/editor
Figma: https://www.figma.com/design/...
```

**Bước 3 — Không cần làm gì thêm.** Claude sẽ tự:
- Pull theme về máy nếu chưa có (không cần hỏi lại)
- Đọc + báo cáo cấu trúc Figma (danh sách page/section tìm được)
- Config Colors/Typography/Product card, push ngay
- Config từng page, validate, push ngay sau mỗi page
- Báo cáo cuối cùng: bảng section → file dùng, và danh sách việc merchant cần làm thêm (ảnh cần
  upload, sản phẩm/collection cần gán tay, v.v.)

Nếu Claude gặp bước cần xác nhận (VD: cần đăng nhập Shopify CLI, hoặc tên layer Figma không rõ
nghĩa), nó sẽ dừng và hỏi trực tiếp — chỉ cần trả lời là tiếp tục được, không cần thao tác gì khác.

## 4. Chuẩn bị trước khi chạy (chỉ cần làm 1 lần)

- File `.env` trong project phải có `FIGMA_ACCESS_TOKEN` (lấy ở Figma → Settings → Personal access
  tokens, chọn quyền "File content: Read-only" là đủ).
- Đã cài Shopify CLI và đăng nhập được store cần setup (Claude sẽ tự nhắc nếu chưa).
- Nếu store có password chặn storefront: **không** lưu password vào `.env` — chỉ cần cung cấp trực
  tiếp trong chat khi Claude hỏi (vì project setup nhiều store khác nhau, không phải 1 store cố định).

## 5. Vài điều cần biết khi review kết quả

- Ảnh (`image_picker`): Claude set sẵn tên file đúng bằng tên layer Figma — chỉ cần export layer đó
  từ Figma và upload lên Shopify Admin, **không cần đổi tên file**, hệ thống tự nhận diện đúng ảnh.
- Sản phẩm/Collection/Video: Figma không có khái niệm tài nguyên Shopify thật, nên các field này
  thường để trống hoặc gán theo dữ liệu collection thật (nếu có) — luôn được liệt kê rõ trong báo cáo
  cuối, không bao giờ tự bịa.
- Mọi thay đổi đều được validate + push ngay theo từng phần nhỏ — nếu có lỗi sẽ được Claude tự phát
  hiện và sửa trước khi báo cáo hoàn thành, không để lỗi "để sau".

## 6. Tài liệu chi tiết hơn (không bắt buộc đọc)

- `CLAUDE.md` — playbook đầy đủ từng bước, rule chi tiết (Claude tự đọc, dùng để tham khảo khi cần
  hiểu sâu hơn 1 quyết định cụ thể Claude đã đưa ra).
- `CHANGELOG.md` — lịch sử bug đã gặp và đã sửa, lý do đằng sau các rule trong CLAUDE.md.

## 7. Auto-test — kiểm tra theme đã có sẵn (việc tách riêng)

Nếu muốn kiểm tra 1 theme ĐÃ ĐƯỢC BUILD (bởi project này hay không cũng được) so với thiết kế Figma
— không setup/config gì cả, chỉ chụp ảnh site thật, so layout + màu/font-size/font-weight/khoảng
cách với Figma, rồi log kết quả vào 1 tab Google Sheet mới — gõ:

```
Test: https://admin.shopify.com/store/<handle>/themes/<themeId>/editor
Figma: https://www.figma.com/design/...
```

Claude sẽ tự đọc `AUTOTEST.md` (playbook riêng, tách hẳn khỏi `CLAUDE.md`) và làm toàn bộ: khám phá
cấu trúc Figma, chụp ảnh site thật, so sánh, tạo/format tab sheet mới đúng theo mẫu team đang dùng
(cột No/Page/Status/Test note/Reopen note), kèm 1 trang gallery ảnh Figma-vs-thực-tế để xem trực
quan. Không cần chuẩn bị gì thêm ngoài phần đã nêu ở mục 4 (Playwright đã cài sẵn từ bước cài đặt).
