# 卓悅研墨會員點數管理平台 MVP

這是一個可本機執行的多分店會員點數管理平台 MVP，包含總部、分店、會員三種角色登入、權限隔離、SQLite 資料庫、密碼加密、點數交易與會員核准扣點流程。

## 技術

- 後端：Node.js 內建 HTTP server
- 資料庫：SQLite（使用 Node 24 內建 `node:sqlite`）
- 登入驗證：簽章 Session Cookie
- 密碼：PBKDF2 + salt 雜湊
- 前端：伺服器渲染 HTML/CSS，無需安裝套件

> 本環境沒有 npm，因此 MVP 採用零外部依賴設計，確保可以直接啟動。

## 專案架構

```text
.
├── data/app.sqlite          # 啟動後自動建立
├── public/
│   ├── hero-business.png    # 商務形象圖
│   └── logo.png             # 卓悅研墨 Logo
├── scripts/
│   ├── init-db.js            # 正式環境初始化，不覆蓋既有資料
│   └── seed.js              # 重建資料庫與種子資料
├── Dockerfile
├── Procfile
├── package.json
├── render.yaml
├── schema.sql
└── server.js
```

## 啟動

本機測試資料：

```bash
node scripts/seed.js
node server.js
```

開啟：

- 總部登入：http://127.0.0.1:3000/admin/login
- 分店登入：http://127.0.0.1:3000/store/login
- 分店專屬登入：http://127.0.0.1:3000/store/taipei-xinyi/login
- 會員登入：http://127.0.0.1:3000/member/login

## 測試帳號

所有測試帳號密碼皆為：

```text
password123
```

| 角色 | Email |
| --- | --- |
| 總部 Admin | admin@joy-yanmo.test |
| 分店 Store | taipei@joy-yanmo.test |
| 會員 Member | member.lin@example.com |

## 建立正式網址

正式網址的流程是：

```text
部署平台 / VPS
↓
Node.js 服務
↓
持久化 SQLite 資料庫
↓
綁定網域
↓
HTTPS
```

### 方案 A：Render 快速上線

1. 將專案推到 GitHub。
2. 到 Render 建立 `Blueprint`，選擇此專案。
3. Render 會讀取 `render.yaml`。
4. 建立以下環境變數：

```text
SESSION_SECRET=一串很長的隨機字串
INITIAL_ADMIN_EMAIL=你的正式總部帳號
INITIAL_ADMIN_PASSWORD=你的正式總部初始密碼
```

5. 第一次部署會自動建立資料庫與總部帳號。
6. 在 Render 的 Custom Domain 綁定正式網域，例如：

```text
members.your-domain.com
```

7. 到網域商 DNS 新增 Render 提供的 CNAME 設定。
8. 等 DNS 生效後，即可使用：

```text
https://members.your-domain.com/admin/login
```

Render 部署設定已包含：

- `HOST=0.0.0.0`
- `NODE_ENV=production`
- `DATABASE_PATH=/var/data/app.sqlite`
- 持久化磁碟 `/var/data`
- 健康檢查 `/healthz`
- HTTPS Cookie

### 方案 B：VPS 上線

在 VPS 安裝 Node.js 24 後：

```bash
cp .env.example .env
node scripts/init-db.js
node server.js
```

建議使用 Nginx 反向代理：

```nginx
server {
  server_name members.your-domain.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

再用 Let's Encrypt 啟用 HTTPS。

### 正式環境注意事項

- 不要在正式環境執行 `node scripts/seed.js`，它會重建測試資料庫。
- 正式環境請執行 `node scripts/init-db.js`，它不會刪除既有資料。
- `SESSION_SECRET` 必須改成正式隨機字串。
- SQLite 可以支撐 MVP，但正式營運建議第二階段升級 PostgreSQL。
- 請定期備份 `DATABASE_PATH` 指向的資料庫檔案。

## MVP 已完成

- 三種角色登入入口
- 總部建立分店與自動產生分店專屬登入連結
- 總部查看全平台購買、消費、結餘、贈予點數統計
- 總部查看分店列表與進入分店視角
- 分店建立會員
- 分店新增購買點數與贈予點數
- 分店發送扣點要求
- 會員查看點數與交易紀錄
- 會員核准或拒絕扣點要求
- 會員核准後自動建立 consume 消費紀錄
- 總部、分店、會員登入後可修改自己的密碼
- 報表匯出中心：總部與分店可下載 CSV / Excel 報表
- 跨店扣點：分店可搜尋全平台會員並送出扣點申請，會員核准後才扣點
- 會員編號：會員自動產生 `YMYYYYMM00001` 格式唯一編號
- 多管理員與申請核准：總部專職管理員可核准、停用、恢復管理員
- 總部管理員登入 / 登出 / 失敗登入稽核紀錄

## 修改密碼

登入後可在左側選單點選「修改密碼」。

修改時需輸入：

- 目前密碼
- 新密碼
- 確認新密碼

系統會驗證目前密碼是否正確，並確認新密碼與確認新密碼一致。修改成功後會自動登出，使用者需要用新密碼重新登入。

## 新增功能路由

- 總部報表：`/admin/reports`
- 分店報表：`/store/reports`
- 跨店扣點：`/store/cross-store`
- 管理員申請：`/admin/manager-requests`、`/store/manager-requests`
- 總部操作紀錄：`/admin/audit-logs`

總部專職管理員：

```text
luodayu168@gmail.com
QazxsW12345
```

首次啟動時若此帳號不存在，系統會自動以 hash 密碼建立；若已存在則不重複建立。

## 第二階段可擴充

- React 或 Next.js 前端重構與 API 拆分
- PostgreSQL 與正式 migration 工具
- Email / SMS 通知
- 匯出報表、進階搜尋與篩選
- 分店細部權限與操作紀錄
- 點數到期日、點數方案與金流串接
- 自訂品牌頁與會員手機版體驗
