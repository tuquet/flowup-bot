# Flowup Telegram Bot (@FlowupAI_bot)

DevOps ChatOps and Server Monitoring assistant daemon for Telegram, packaged strictly according to `/root/GEMINI.md` guidelines.

---

## 1. Cấu Trúc Ứng Dụng

```text
/root/flowup-bot/
├── bin/
│   └── flowup-bot        # CLI quản lý và điều khiển daemon
├── config/
│   ├── .env              # Biến môi trường, Bot token, Whitelist
│   ├── .env.example      # File mẫu cấu hình
│   └── default.json      # Cấu hình danh mục theo dõi và repo
├── data/                 # Thư mục dữ liệu ứng dụng
├── logs/                 # Thư mục lưu trữ log
├── scripts/              # Helper scripts
├── src/
│   ├── config.js         # Module nạp config và phân quyền admin
│   ├── index.js          # Entrypoint Bot, router và inline keyboard handlers
│   └── services/
│       ├── github.js     # Tích hợp GitHub Actions (gh CLI)
│       └── system.js     # Giám sát tài nguyên máy chủ & site health
├── install.sh            # Cài đặt tự động & đăng ký systemd
├── uninstall.sh          # Gỡ bỏ sạch sẽ service & symlinks
├── package.json          # Quản lý dependencies (grammy, dotenv)
└── README.md             # Tài liệu này
```

---

## 2. Quản Trị Hệ Thống Qua CLI

Bot được phơi lệnh toàn cục qua `/usr/local/bin/flowup-bot`. Bạn có thể chạy các lệnh quản trị từ bất kỳ đâu trên VPS:

```bash
# Kiểm tra trạng thái daemon
flowup-bot status

# Xem log thời gian thực
flowup-bot logs

# Khởi động lại bot sau khi cập nhật cấu hình
flowup-bot restart

# Dừng bot
flowup-bot stop

# Chạy bot ở chế độ debug trực tiếp trên terminal
flowup-bot run
```

---

## 3. Danh Mục Lệnh Trong Telegram

| Lệnh | Chức năng | Phân quyền |
| :--- | :--- | :--- |
| `/start` hoặc `/help` | Mở bảng điều khiển với bàn phím nút bấm nhanh (Inline Keyboard) | Tất cả |
| `/ci` hoặc `/ci all` hoặc `/ci <repo>` | Tra cứu trạng thái GitHub Actions (`/ci` mặc định, `/ci all` tổng hợp 10+ repos, `/ci <repo>` chi tiết) | Tất cả |
| `/deploy` | Kích hoạt build & deploy website tức thì lên GitHub Pages | **Admin Only** |
| `/releases` | Xem danh sách các phiên bản phần mềm phát hành mới nhất từ Releases Portal (toàn bộ 12+ repos) | Tất cả |
| `/logs` hoặc `/logs <repo>` | Trích xuất tóm tắt log lỗi nếu build bị fail của repo chỉ định | Tất cả |
| `/site` | Kiểm tra HTTP Status, độ trễ và hạn chứng chỉ SSL của website | Tất cả |
| `/server` hoặc `/sys` | Xem thông số CPU load, RAM, Ổ cứng và Uptime của VPS | **Admin Only** |
| `/services` | Xem trạng thái các dịch vụ hệ thống (Docker, SSH, flowup-bot) | **Admin Only** |
| `/repos` | Xem danh sách các repository GitHub gần nhất | Tất cả |

---

## 4. Bảo Mật & Phân Quyền

- Cấu hình file `/root/flowup-bot/config/.env`:
  - `ALLOWED_CHAT_IDS`: Chỉ nhóm chat hoặc ID người dùng được phép mới có thể tương tác với bot.
  - `ADMIN_USER_IDS`: Chỉ tài khoản admin (ví dụ: Tu Dinh `1038133235`) mới có thể chạy các lệnh nhạy cảm như `/deploy`, `/server`, `/services`.
