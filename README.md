# AI Support Theme

Tự động build/reconfigure trang Shopify theme dựa trên thiết kế Figma — dùng Claude (qua Claude
Code app) hoặc chạy server tự động bằng API key.

Xem thêm:
- [`ONBOARDING.md`](ONBOARDING.md) — bản tóm tắt kiến trúc + cách dùng nhanh cho team.
- [`CLAUDE.md`](CLAUDE.md) — playbook Auto-**setup** (build/reconfigure theme từ Figma), chi tiết
  từng bước (Claude tự đọc, không cần đọc để dùng).
- [`AUTOTEST.md`](AUTOTEST.md) — playbook Auto-**test** riêng biệt (kiểm tra 1 theme đã có sẵn so
  với Figma, log kết quả vào Google Sheet) — tách hẳn khỏi Auto-setup, kích hoạt bằng từ khóa
  `Test:` thay vì `Setup:`.
- [`CHANGELOG.md`](CHANGELOG.md) — lịch sử bug đã sửa và lý do các rule tồn tại.

## Yêu cầu hệ thống

- [Node.js](https://nodejs.org/) (v18+)
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) đã cài và đăng nhập được store cần setup
  ```bash
  npm install -g @shopify/cli @shopify/theme
  shopify login --store <ten-store>.myshopify.com
  ```
- [Claude Code](https://claude.com/claude-code) đã cài (dùng cho Mode 2, xem bên dưới)

## Cài đặt

```bash
git clone <repo-url>
cd "AI Support Theme"
npm install
npx playwright install chromium
cp .env.example .env
```

(`playwright install chromium` tải trình duyệt headless dùng cho Auto-test —
`scripts/screenshot-theme-page.js`/`check-computed-style.js` — chỉ cần chạy 1 lần.)

Mở `.env` và điền:

```env
FIGMA_ACCESS_TOKEN=your_figma_token_here
```

Lấy token tại **Figma → Settings → Personal access tokens**, quyền `File content: Read-only` là đủ.
Token này **luôn bắt buộc** ở cả 2 chế độ chạy bên dưới.

## 2 chế độ chạy — chỉ chọn 1, không trộn

### Mode 1 — Tự động qua API key

Điền thêm `ANTHROPIC_API_KEY` vào `.env`, rồi:

```bash
npm start
```

Server (`src/server.js`) tự chạy toàn bộ pipeline Figma → Shopify qua Projects API/UI
(`public/`), không cần mở Claude Code.

### Mode 2 — Dùng Claude Code app (khuyến nghị cho team, không cần API key)

**Bước 1.** Để trống `ANTHROPIC_API_KEY` trong `.env` (hoặc không set) — không chạy `npm start`.

**Bước 2.** Mở project này bằng Claude Code:

```bash
cd "AI Support Theme"
claude
```

(hoặc mở thư mục này trong Claude Code app / IDE extension tương ứng)

**Bước 3.** Gõ yêu cầu ngay trong khung chat Claude Code — có 2 loại việc RIÊNG BIỆT, không trộn:

**Auto-setup** (build/reconfigure theme từ Figma — Claude đọc `CLAUDE.md`):
```
setup theme <ten-store>.myshopify.com theme <themeId>
figma: https://www.figma.com/design/<fileKey>/<ten-file>?node-id=...
```
hoặc dùng link editor admin có sẵn:
```
Setup: https://admin.shopify.com/store/<handle>/themes/<themeId>/editor
Figma: https://www.figma.com/design/...
```

**Auto-test** (kiểm tra 1 theme ĐÃ CÓ SẴN so với Figma, log kết quả vào Google Sheet — Claude đọc
`AUTOTEST.md`, không config gì cả):
```
Test: https://admin.shopify.com/store/<handle>/themes/<themeId>/editor
Figma: https://www.figma.com/design/...
```

**Bước 4.** Không cần làm gì thêm:
- Với **Setup**: Claude Code tự pull theme, phân tích Figma, config Colors/Typography/Product card,
  config từng page, validate, push lên Shopify, rồi báo cáo kết quả (section nào dùng file nào,
  việc gì merchant cần làm thêm).
- Với **Test**: Claude Code tự chụp ảnh site thật, so với Figma (layout + font-size/font-weight/
  màu...), log kết quả vào tab Google Sheet mới, kèm gallery ảnh so sánh.

Nếu Shopify CLI yêu cầu đăng nhập giữa chừng, Claude Code sẽ dừng lại và đưa link/code xác thực —
chỉ cần đăng nhập rồi báo lại là tiếp tục được.

Chi tiết đầy đủ luồng xử lý và cách dùng: xem [`ONBOARDING.md`](ONBOARDING.md).

## Lưu ý bảo mật

- Chỉ `FIGMA_ACCESS_TOKEN` (và `ANTHROPIC_API_KEY` nếu dùng Mode 1) nên nằm trong `.env`.
- **Không** lưu password storefront hay token riêng của từng store vào `.env` — project này setup
  nhiều store khác nhau, mật khẩu store nào cần thì cung cấp trực tiếp trong chat khi Claude hỏi.
