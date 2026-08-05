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

本機測試資料的登入資訊由 Seed 指令輸出，僅限隔離的開發資料庫使用；正式環境不得使用測試帳號、共用密碼或範例密碼。

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
# 核心會員資料架構（開發中）

版本化遷移位於 `migrations/`，啟動與 `npm run migrate` 都會依序套用尚未執行的新增式遷移。已套用檔案的 SHA-256 會記錄於 `schema_migrations`；遷移檔套用後不得修改。

會員自行註冊與匯入啟用預設關閉，可由資料庫 `feature_flags` 控制；環境變數 `FEATURE_MEMBER_SELF_REGISTRATION` 與 `FEATURE_MEMBER_IMPORT_ACTIVATION` 若有設定則優先。正式環境在另行核准前不得設為 `true`。

會員啟用信使用 Resend HTTPS API。正式啟用前須另行核准並在部署環境設定 `APP_BASE_URL`、`RESEND_API_KEY`、`ACTIVATION_EMAIL_FROM` 與 `ACTIVATION_TOKEN_TTL_MINUTES`；API Key 不得寫入 Repository。正式 `APP_BASE_URL` 必須使用 HTTPS。自動測試注入假傳輸，不寄送真實 Email。

## 訂單中心與綠界環境

Render 核心平台已準備下列「預設關閉」能力：

- 總部訂單中心：`/admin/orders`
- 商品後台統一設定建議售價、成交方案、運費、七項分潤與相關人員
- Stage 與 Production 讀取同一筆成交方案，不設獨立測試價格
- 菱烏金炭皂 `SOAP001`：建議售價 NT$600；體驗組商品 NT$200＋運費 NT$65
- 商品金額參與分潤，運費不參與分潤
- 固定分潤欄位：供應商、內容製作、成交分享、平台、永久推薦、商品引薦、剩餘獎勵池
- 綠界 Stage 建立訂單
- `ReturnURL` 伺服器通知與 `OrderResultURL` 消費者返回頁分離
- CheckMacValue、MerchantID、訂單金額與測試環境驗證
- 重複回傳冪等處理
- 付款成功後建立完整分配快照
- 龍捲風通知中心付款測試通知

正式金流、真實扣款與正式退款均未啟用。測試與正式環境的 MerchantID、HashKey、HashIV
使用不同欄位，且只可設定在 Render Environment Variables，不得寫入 Repository。環境變數預設如下：

```text
ECPAY_MODE=disabled
ECPAY_STAGE_ENABLED=false
ECPAY_MERCHANT_ID=
ECPAY_HASH_KEY=
ECPAY_HASH_IV=
ECPAY_CREDIT_ENABLED=false
ECPAY_ATM_ENABLED=false
ECPAY_CVS_ENABLED=false
ECPAY_PRODUCTION_ENABLED=false
ECPAY_PRODUCTION_MERCHANT_ID=
ECPAY_PRODUCTION_HASH_KEY=
ECPAY_PRODUCTION_HASH_IV=
ECPAY_PRODUCTION_CREDIT_ENABLED=false
ECPAY_PRODUCTION_ATM_ENABLED=false
ECPAY_PRODUCTION_CVS_ENABLED=false
LINE_WEBHOOK_URL=
```

只有在另行核准測試付款後，才可將 `ECPAY_MODE=stage`、
`ECPAY_STAGE_ENABLED=true` 與 `ECPAY_CREDIT_ENABLED=true`。

正式付款即使程式已準備完成，仍須同時滿足下列條件才會開放：

- `ECPAY_MODE=production`
- `ECPAY_PRODUCTION_ENABLED=true`
- `ECPAY_PRODUCTION_MERCHANT_ID=3222651`
- 正式 `ECPAY_PRODUCTION_HASH_KEY` 與 `ECPAY_PRODUCTION_HASH_IV` 均已設定
- `ECPAY_PRODUCTION_CREDIT_ENABLED=true`

任一條件不成立，`/checkout/SOAP001` 會顯示「正式付款尚未開放」，且不會建立綠界正式付款。
`SOAP001` 正式方案以伺服器資料庫為準：體驗組 NT$200＋運費 NT$65＝NT$265，另含買5送1、
買10送3與買20送10。運費不列入商品分潤；付款成功後才依 PR #7 的推薦與收益架構建立分配快照。

本階段仍不包含正式退款、LT Token 發放或完整銀行帳號儲存。
