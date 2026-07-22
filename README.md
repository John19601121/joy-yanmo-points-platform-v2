# LT 大健康成交會員積分管理平台 V1.0 正式版

LT 大健康成交會員積分管理平台是支援總部、分店與會員三種角色的多分店會員積分系統，包含權限隔離、跨店會員查詢、會員核准扣點、報表匯出與總部管理稽核。

## 正式版功能

- 總部、分店、會員三種角色登入
- 登入後透過 `/account/password` 修改密碼
- 多管理員帳號、管理員申請、核准、停用與恢復
- 總部管理員登入、登出與失敗登入紀錄
- 會員唯一編號，格式為 `LTYYYYMM00001`
- 跨店會員查詢與跨店扣點申請
- 會員核准或拒絕扣點，點數不足時阻止核准
- 總部與分店報表中心
- CSV 與 Excel 匯出
- 商城商品資料 MVP，支援商品類型、分類、商品與會員成交中心連動
- Email 可跨角色重複；同角色不可重複
- 資料重複時顯示友善提示，不會因 UNIQUE 錯誤形成 Render 502

## 技術架構

- Node.js 24 內建 HTTP server
- SQLite（Node.js 內建 `node:sqlite`）
- 簽章 Session Cookie
- PBKDF2 + salt 密碼雜湊
- 伺服器端 HTML/CSS，零外部套件

## Repository 結構

```text
.
├── public/
│   ├── favicon.png
│   ├── hero-business.png
│   └── logo.png
├── scripts/
│   ├── init-db.js
│   └── seed.js
├── Dockerfile
├── Procfile
├── package.json
├── render.yaml
├── schema.sql
├── server.js
├── README.md
├── .env.example
└── .gitignore
```

執行後建立的 `data/app.sqlite` 屬於本機資料，不納入版本控制。

## 本機啟動

```bash
cp .env.example .env
node scripts/seed.js
node server.js
```

登入入口：

- 總部：`http://127.0.0.1:3000/admin/login`
- 分店：`http://127.0.0.1:3000/store/login`
- 分店專屬連結：`http://127.0.0.1:3000/store/taipei-xinyi/login`
- 會員：`http://127.0.0.1:3000/member/login`

本機測試資料的密碼由開發環境自行設定；正式環境不得使用共用或範例密碼：

| 角色 | Email |
| --- | --- |
| 總部 Admin | `admin@lt-health-sales.test` |
| 分店 Store | `taipei@lt-health-sales.test` |
| 會員 Member | `member.lin@example.com` |

## Render 部署

`render.yaml` 已設定持久化 SQLite 磁碟、健康檢查與正式環境 Cookie。Render Start Command 必須維持：

```text
node scripts/init-db.js && node server.js
```

部署前請設定：

```text
SESSION_SECRET=一串足夠長的隨機字串
INITIAL_ADMIN_EMAIL=正式總部帳號
INITIAL_ADMIN_PASSWORD=正式總部初始密碼
INITIAL_ADMIN_NAME=總部管理員名稱
```

正式環境請勿執行 `node scripts/seed.js`，該指令會重建測試資料庫。`node scripts/init-db.js` 只初始化必要結構，不會覆蓋既有資料。

## 主要路由

- 修改密碼：`/account/password`
- 總部報表：`/admin/reports`
- 分店報表：`/store/reports`
- 跨店扣點：`/store/cross-store`
- 管理員申請：`/admin/manager-requests`、`/store/manager-requests`
- 總部管理員操作紀錄：`/admin/audit-logs`
- 總部商城管理：`/admin/mall`
- 分店商城：`/store/mall`
- 會員商城：`/member/mall`
- 會員商品成交中心：`/member/share-center?product=SOAP001`

## 商城資料

目前商城 MVP 會建立三層商品資料：

- 商品類型：`product_types`
- 商品分類：`product_categories`
- 商品：`products`

系統啟動時會安全確認測試商品 `SOAP001 烏金炭皂` 存在，不會重複新增同一個商品編號。商品價格可留空，前台會顯示「價格洽詢」。

## 正式環境注意事項

- 必須設定正式的 `SESSION_SECRET`。
- `SESSION_SECRET` 至少需 32 個字元；正式環境缺少必要安全設定時，服務會拒絕啟動。
- `INITIAL_ADMIN_EMAIL` 與 `INITIAL_ADMIN_PASSWORD` 不得使用公開範例值；既有部署升級後會執行一次性的管理員密碼輪替。
- 新增分店與會員時，初始密碼需為 12 至 128 個字元；核准管理員時會產生只顯示一次的隨機臨時密碼。
- SQLite 資料庫位置由 `DATABASE_PATH` 控制；Render 預設為 `/var/data/app.sqlite`。
- 請定期備份持久化資料庫。
- 初始帳號登入後應立即修改密碼。
