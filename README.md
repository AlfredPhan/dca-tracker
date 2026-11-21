# Altcoin DCA Tracker

Website tĩnh để quản lý các lệnh mua/bán altcoin spot và tự tính **giá DCA (giá vốn trung bình)**.

## Cách tính
- **Mua**: Số lượng = Vốn ÷ Giá. Giá DCA = Tổng vốn ÷ Tổng số lượng.
- **Bán**: giảm số lượng và vốn theo giá DCA hiện tại. Giá DCA của phần còn lại giữ nguyên, phần chênh lệch được ghi vào "Lãi/lỗ đã chốt".
- Giá hiện tại lấy từ Binance (cặp USDT), tự cập nhật mỗi 30 giây.

## Dữ liệu
Dữ liệu chỉ lưu trong `localStorage` của trình duyệt, không gửi đi đâu cả. Muốn sao lưu hoặc chuyển sang máy khác thì bấm **Xuất** để lấy file JSON, rồi bấm **Nhập** ở máy kia.

## Deploy lên GitHub Pages
1. Tạo repo mới trên GitHub, ví dụ `dca-tracker`.
2. Đẩy code lên:
   ```bash
   git init
   git add .
   git commit -m "Altcoin DCA tracker"
   git branch -M main
   git remote add origin https://github.com/<username>/dca-tracker.git
   git push -u origin main
   ```
3. Trên GitHub vào **Settings → Pages → Source: Deploy from a branch**, chọn `main` / `(root)` rồi bấm **Save**.
4. Sau khoảng 1 phút, web sẽ chạy tại `https://<username>.github.io/dca-tracker/`

## Dữ liệu unlock và on-chain (`scripts/build-data.mjs`)
GitHub Actions (`.github/workflows/pages.yml`) chạy mỗi giờ và mỗi lần push: tạo `data/unlocks.json` (lịch mở khóa token, nguồn DefiLlama)
và `data/onchain.json` (coin nạp/rút sàn 24h, nguồn Blockscout) rồi deploy website. Thư mục `data/` không lưu trong git.
Thêm token on-chain: sửa `ONCHAIN` trong `scripts/build-data.mjs` (chỉ token trên Ethereum).

Link mở thẳng một coin ở tab cá voi: `.../dca-tracker/#whale=ARB`.

## Bot cảnh báo Telegram (`alert-worker/`)
Cloudflare Worker chạy mỗi phút, quét lệnh lớn của các coin trong `COINS` (file `alert-worker/wrangler.toml`) và nhắn Telegram.
Nguồn chính là Binance, nếu Binance chặn thì dùng OKX. `EXTRA` cho phép quét thêm sàn phụ cho từng coin (hiện tại TIA trên Bybit, FET trên Coinbase). Secrets `TELEGRAM_TOKEN`, `CHAT_ID` đặt trong dashboard Cloudflare.

Tin nhắn 8:00 sáng kèm lịch unlock trong 3 ngày tới của các coin trong `COINS`.

Đổi coin/ngưỡng: sửa `COINS` rồi chạy `npx wrangler deploy` trong thư mục `alert-worker`.
