# BE-SEC-01 — Test Guide: Helmet Security Headers

## Mục tiêu

Xác nhận các security headers được gắn đúng vào **tất cả response** từ API Gateway và Auth Service.

---

## Headers cần kiểm tra

| Header                      | Giá trị mong đợi                  | Mục đích                                |
| --------------------------- | --------------------------------- | --------------------------------------- |
| `X-Content-Type-Options`    | `nosniff`                         | Ngăn MIME sniffing                      |
| `X-Frame-Options`           | `DENY`                            | Ngăn Clickjacking                       |
| `X-XSS-Protection`          | `0`                               | Tắt XSS filter cũ (theo chuẩn hiện đại) |
| `Referrer-Policy`           | `strict-origin-when-cross-origin` | Giới hạn thông tin Referer              |
| `X-DNS-Prefetch-Control`    | `off`                             | Ngăn DNS prefetch                       |
| `X-Powered-By`              | **không có**                      | Ẩn tech stack                           |
| `Strict-Transport-Security` | `max-age=31536000; ...`           | Chỉ có ở **production**                 |
| `Content-Security-Policy`   | chứa `default-src 'self'`         | Chỉ có ở **production**                 |

---

## Cách test

### 1. Khởi động service

```bash
# Terminal 1 — API Gateway (port 3000)
cd services/api-gateway
npm run dev

# Terminal 2 — Auth Service (port 3001)
cd services/auth-service
npm run dev
```

---

### 2. Test bằng `curl` (nhanh nhất)

```bash
# API Gateway — gọi bất kỳ endpoint nào, chỉ cần xem headers
curl -I http://localhost:3000/api/v1/health

# Auth Service
curl -I http://localhost:3001/api/v1/auth/login
```

**Output mong đợi (dev mode):**

```
HTTP/1.1 200 OK
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 0
Referrer-Policy: strict-origin-when-cross-origin
X-DNS-Prefetch-Control: off
# Không có X-Powered-By
# Không có Strict-Transport-Security  (dev mode)
# Không có Content-Security-Policy    (dev mode — để Swagger chạy được)
```

---

### 3. Test bằng Postman

1. Gửi `GET http://localhost:3000/api/v1/health`
2. Click tab **Headers** trong response
3. Tìm và verify các headers trong bảng trên

---

### 4. Test bằng Browser DevTools

1. Mở `http://localhost:3000/api/v1/health` trong browser
2. Mở DevTools → tab **Network**
3. Click vào request → tab **Response Headers**
4. Confirm các headers xuất hiện

---

### 5. Test production headers (NODE_ENV=production)

Để test CSP và HSTS, tạm thời set env trước khi chạy:

```bash
# Windows PowerShell
$env:NODE_ENV="production"; npm run dev

# Linux/Mac
NODE_ENV=production npm run dev
```

Sau đó curl lại:

```bash
curl -I http://localhost:3000/api/v1/health
```

**Thêm headers cần thấy:**

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Content-Security-Policy: default-src 'self'; ...
```

> ⚠️ Swagger UI (`/docs`) sẽ **bị vỡ** khi chạy production mode do CSP chặn inline script — đây là hành vi đúng.

---

### 6. Verify `X-Powered-By` đã bị xóa

```bash
curl -I http://localhost:3000/api/v1/health | grep -i "powered"
# Không có output = PASS
```

---

## Checklist PASS/FAIL

Chạy lệnh sau để check nhanh tất cả headers 1 lần:

```bash
curl -s -I http://localhost:3000/api/v1/health | grep -E "x-content-type|x-frame|referrer-policy|x-dns|x-powered-by"
```

**Kết quả PASS:**

```
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: strict-origin-when-cross-origin
x-dns-prefetch-control: off
# Dòng x-powered-by KHÔNG xuất hiện = đã bị ẩn thành công
```

---

## Lưu ý

- `X-XSS-Protection: 0` là **đúng theo chuẩn 2024** — các browser hiện đại đã remove tính năng này, set về 0 tránh bug trên một số browser cũ.
- `Strict-Transport-Security` và `Content-Security-Policy` chỉ active khi `NODE_ENV=production` — đây là thiết kế có chủ đích để Swagger UI hoạt động trong dev.
- Config nằm tại:
  - `services/api-gateway/src/common/config/helmet.config.ts`
  - `services/auth-service/src/common/config/helmet.config.ts`
