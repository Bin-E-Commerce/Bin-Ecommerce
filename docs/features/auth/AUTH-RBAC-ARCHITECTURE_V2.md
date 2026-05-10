# Auth & RBAC Architecture

Tài liệu này mô tả toàn bộ luồng xác thực (Authentication) và phân quyền (RBAC) của hệ thống Bin E-Commerce, từ Frontend → API Gateway → Auth Service → Keycloak.

---

## 1. Tổng quan kiến trúc

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser (Next.js 14)                                                   │
│                                                                         │
│  Memory:      accessToken (5 min)   ← Redux store                      │
│  httpOnly cookie: refresh_token (30 min)  ← không đọc được từ JS       │
└───────────────────┬────────────────────────────────────────────────────-┘
                    │ HTTP + Cookie
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  API Gateway  :3000                                                     │
│                                                                         │
│  JwtAuthGuard  → verify JWT via JWKS (RS256)                            │
│                → inject x-user-id / x-user-email / x-user-roles        │
│  @Public()     → skip JWT check (login, register, refresh, ...)         │
│  ProxyService  → forward request + Cookie header → upstream service     │
│                → forward Set-Cookie header từ upstream về browser        │
└───────────────────┬─────────────────────────────────────────────────────┘
                    │ Internal HTTP (Docker network)
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Auth Service  :3001   (PostgreSQL + Redis)                             │
│                                                                         │
│  AuthController   → login / register / refresh / logout / social        │
│  TokenService     → gọi Keycloak token endpoint (ROPC / refresh grant)  │
│  OtpService       → Redis OTP (SHA-256 hash, TTL 10 min, max 3 tries)   │
│  KeycloakAdminService → tạo / xóa user, gán role trong Keycloak         │
│  RefreshToken DB  → lưu hash của refresh token (revocation support)     │
└───────────────────┬─────────────────────────────────────────────────────┘
                    │ Admin REST API / Token endpoint
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Keycloak  :8080   Realm: bin-ecommerce                                 │
│                                                                         │
│  Clients:  auth-service (ROPC)  │  auth-service-admin (admin API)       │
│            web-client (PKCE / social)                                   │
│  Tokens:   accessToken TTL 5 min │ refreshToken TTL 30 min (sliding)    │
│  JWKS:     /realms/bin-ecommerce/protocol/openid-connect/certs          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Luồng Đăng ký (Register — 2 bước OTP)

### Bước 1 — Khởi tạo đăng ký

```
FE  POST /api/v1/auth/register/initiate
    Body: { email, name, password, phone? }
    (không cần auth — @Public())

API GW  → AuthProxyController → ProxyService → auth-service

Auth Service:
  1. Kiểm tra email đã tồn tại chưa (userRepo)
  2. Tạo OTP 6 chữ số (randomInt), hash SHA-256
  3. Lưu Redis key "otp:REGISTER:<email>": { otpHash, extraData: {name, phone, passwordForKc}, attempts:0, expiresAt: now+10min, resendCooldown: now+60s }
  4. Gửi email OTP (hiện tại: log ra console — TODO: Kafka → notification-service)
  5. Trả về: { message: "OTP sent", expiresIn: 600 }
```

### Bước 2 — Xác thực OTP

```
FE  POST /api/v1/auth/register/verify
    Body: { identifier: email, otp: "123456" }
    (không cần auth — @Public())

Auth Service:
  1. Lấy Redis key otp:REGISTER:<email>
  2. Hash OTP nhập vào, so sánh với otpHash đã lưu
  3. Kiểm tra attempts < maxAttempts (3), expiresAt > now
  4. Tạo user trong Keycloak (KeycloakAdminService.createUser)
     → Keycloak trả về keycloakId (UUID)
  5. Gán realm role CUSTOMER cho user trong Keycloak
  6. Lưu user vào PostgreSQL local DB
     → Nếu lưu DB thất bại: xóa user Keycloak (compensating transaction)
  7. Gọi Keycloak token endpoint (ROPC grant) → lấy TokenPair
  8. Hash refreshToken → lưu vào bảng refresh_tokens (kèm IP, userAgent, expiresAt)
  9. Set httpOnly cookie "refresh_token" (maxAge 30 min, path /api/v1/auth)
  10. Trả về: { accessToken, expiresIn, user: { id, email, name, role, ... } }
      (refreshToken KHÔNG có trong body — chỉ trong cookie)

FE nhận:
  → dispatch setAuth({ accessToken, user }) → lưu vào Redux
  → cookie refresh_token tự động lưu bởi browser (httpOnly — JS không đọc được)
  → router.push('/') → vào trang chính
```

---

## 3. Luồng Đăng nhập (Login)

```
FE  POST /api/v1/auth/login
    Body: { email, password }
    (không cần auth — @Public())

Auth Service:
  1. Gọi Keycloak token endpoint (Resource Owner Password Credentials Grant)
     → Keycloak xác thực email/password → trả về access_token, refresh_token
  2. Lấy user từ PostgreSQL theo email
  3. Kiểm tra user.status === ACTIVE (nếu bị ban → 401)
  4. Cập nhật user.lastLoginAt
  5. Hash refreshToken → lưu vào bảng refresh_tokens
  6. Set httpOnly cookie "refresh_token" (path /api/v1/auth, maxAge 30 min)
  7. Trả về: { accessToken, expiresIn, user }

FE nhận:
  → dispatch setAuth({ accessToken, user })
  → router.push('/')
```

---

## 4. Luồng Restore Session (1 API call khi reload trang)

```
Browser reload
  ↓
StoreProvider.useEffect() chạy (client-side, 1 lần duy nhất)
  1. setAppStore(store)     → inject Redux store vào authorizedAxios interceptor
  2. dispatch(initAuth())

initAuth thunk:
  POST /api/v1/auth/refresh
  Body: {} (rỗng)
  Cookie: refresh_token=<httpOnly> ← browser tự đính kèm

API GW:
  → AuthProxyController.refresh() — đây là @Public() route
  → ProxyService.forward() — forward Cookie header đến auth-service

Auth Service:
  1. Đọc cookie refresh_token (cookie-parser đã parse)
  2. Hash token → tìm trong bảng refresh_tokens
  3. Kiểm tra: chưa bị revoke, chưa hết hạn
  4. Gọi Keycloak rotateRefreshToken → lấy TokenPair mới (refresh token rotation)
  5. Revoke token cũ trong DB, lưu token mới
  6. Set httpOnly cookie mới (sliding window: TTL reset về 30 min)
  7. Trả về: { accessToken, expiresIn, user }

API GW nhận response:
  → ProxyService trả về cả headers từ upstream
  → AuthProxyController.forward() gọi res.setHeader("Set-Cookie", ...) 
  → Browser nhận cookie mới

FE nhận:
  → initAuth.fulfilled: state.accessToken = accessToken, state.user = user
  → state.initialized = true → app bắt đầu render bình thường
  → XONG — chỉ 1 API call duy nhất!
```

---

## 5. Luồng Gọi API được bảo vệ (Authorized Request)

```
FE gọi GET /api/v1/users/me (hoặc bất kỳ API nào cần auth)

authorizedAxios.interceptors.request:
  → Lấy accessToken từ Redux store
  → Đính kèm header: Authorization: Bearer <accessToken>

API GW — JwtAuthGuard:
  1. Đọc Authorization header
  2. Decode JWT header → lấy kid (Key ID)
  3. Gọi JWKS endpoint Keycloak lấy public key (cache 1 giờ)
  4. Verify chữ ký RS256 + kiểm tra issuer
  5. Inject vào request headers:
     x-user-id    = payload.sub
     x-user-email = payload.email
     x-user-roles = payload.roles.join(',')
  6. Forward request + injected headers → auth-service

Auth Service — UserController.getProfile():
  → Đọc x-user-id header (không verify JWT lần 2 — đã tin tưởng gateway)
  → userRepo.findOne({ id })
  → Trả về user profile
```

---

## 6. Luồng Auto-Refresh Token (401 Retry)

Khi accessToken hết hạn (sau 5 phút), `authorizedAxios` interceptor tự xử lý:

```
API trả về 401
  ↓
authorizedAxios.interceptors.response:
  1. Kiểm tra không phải /auth/refresh đang fail (tránh loop vô hạn)
  2. Đánh dấu originalRequest._retry = true
  3. Nếu chưa có refreshTokenPromise đang chạy → tạo mới:
     POST /api/v1/auth/refresh  ← cookie tự đính kèm
     → nhận { accessToken, user }
     → dispatch setAuth({ accessToken, user })  ← cập nhật Redux
     → onRefreshed(true)  → giải phóng hàng đợi
  4. Nếu đã có refreshTokenPromise → đưa request vào hàng đợi subscribers[]
     (tránh gọi /refresh nhiều lần đồng thời khi nhiều request fail cùng lúc)
  5. Sau khi refresh xong:
     → Đính kèm accessToken mới vào originalRequest.headers.Authorization
     → Retry request gốc tự động

Nếu refresh cũng fail (401):
  → dispatch logoutUser()  → clearAuth()  → redirect /login
```

---

## 7. Luồng Đăng xuất (Logout)

```
FE  POST /api/v1/auth/logout
    Body: {} (không cần gửi refreshToken — đọc từ cookie)
    Authorization: Bearer <accessToken>  ← bảo vệ bởi JwtAuthGuard

Auth Service:
  1. Đọc cookie refresh_token
  2. Hash → update refresh_tokens SET revokedAt = now
  3. Gọi Keycloak /revoke endpoint để vô hiệu hóa cả Keycloak session
  4. res.clearCookie("refresh_token") → xóa cookie trên browser

FE:
  → dispatch logoutUser.fulfilled → clearAuth()
  → accessToken = null, user = null trong Redux
  → router.push('/login')
```

---

## 8. Luồng Social Login (Google / Facebook)

```
Bước 1: Lấy URL redirect
FE  GET /api/v1/auth/social/start/:provider
  ← trả về { authUrl, state }

Bước 2: Redirect user đến Keycloak
  → Keycloak redirect đến Google/Facebook OAuth
  → Sau khi user chấp nhận → Keycloak redirect về FE với code + state

Bước 3: Exchange code
FE  POST /api/v1/auth/social/callback/:provider
    Body: { code, state }

Auth Service:
  1. Kiểm tra state hợp lệ (anti-CSRF, TTL 10 min)
  2. Gọi Keycloak token endpoint với code (Authorization Code Grant)
  3. Decode id_token → lấy keycloakId, email, name
  4. Upsert user trong PostgreSQL:
     - Nếu user mới: tạo user + gán role CUSTOMER trong Keycloak
     - Nếu email đã tồn tại: link keycloakId vào tài khoản cũ
  5. Set httpOnly cookie + trả về { accessToken, expiresIn, user }
```

---

## 9. Bảo mật — Refresh Token Rotation

Mỗi lần refresh token được sử dụng, hệ thống:

1. **Revoke** token cũ trong DB (`revokedAt = now`)
2. **Issue** token mới từ Keycloak
3. **Lưu** hash của token mới vào DB
4. **Set** cookie mới với token mới

**Phát hiện token bị đánh cắp:**
- Nếu token đã bị revoke mà vẫn được dùng → hệ thống nhận ra nguy cơ bị lộ
- Tự động revoke **tất cả** refresh token của user đó → ép đăng nhập lại

---

## 10. Cấu trúc Token

### Access Token (JWT — RS256)

```json
{
  "sub": "<uuid>",           // User ID (keycloakId)
  "email": "user@email.com",
  "roles": ["CUSTOMER"],     // Realm roles từ Keycloak
  "iss": "http://localhost:8080/realms/bin-ecommerce",
  "exp": 1234567890,         // now + 5 phút
  "iat": 1234567590
}
```

### Cookie `refresh_token`

| Thuộc tính | Giá trị |
|---|---|
| `HttpOnly` | `true` — JS không đọc được |
| `Secure` | `true` trong production |
| `SameSite` | `Lax` |
| `Path` | `/api/v1/auth` — chỉ gửi đến auth endpoints |
| `MaxAge` | 1800s (30 phút, sliding window) |

---

## 11. Database Schema (auth-service — PostgreSQL)

```
users
  id            UUID PK
  email         VARCHAR UNIQUE INDEX
  name          VARCHAR
  phone         VARCHAR nullable
  keycloak_id   VARCHAR UNIQUE INDEX
  role          ENUM(CUSTOMER, ADMIN, STAFF)
  status        ENUM(ACTIVE, INACTIVE, BANNED)
  avatar_url    TEXT nullable
  last_login_at TIMESTAMPTZ nullable
  created_at    TIMESTAMPTZ
  updated_at    TIMESTAMPTZ

refresh_tokens
  id            UUID PK
  user_id       UUID FK → users.id (CASCADE DELETE)
  token_hash    VARCHAR(64) INDEX  ← SHA-256 của raw token
  issued_at     TIMESTAMPTZ
  expires_at    TIMESTAMPTZ
  revoked_at    TIMESTAMPTZ nullable
  ip_address    VARCHAR nullable
  user_agent    TEXT nullable

otp_challenges  (lưu tạm — thực ra dùng Redis)
  id            UUID PK
  identifier    VARCHAR  (email hoặc phone)
  otp_hash      VARCHAR(64)  ← SHA-256 của raw OTP
  purpose       ENUM(REGISTER, LOGIN, RESET_PASSWORD)
  expires_at    TIMESTAMPTZ
  attempts      INT default 0
  max_attempts  INT default 3
  resend_at     TIMESTAMPTZ nullable
  extra_data    TEXT nullable  ← JSON: { name, phone, passwordForKc }
```

**Redis (OTP)**

```
Key:   otp:<PURPOSE>:<identifier>
TTL:   600s (10 phút)
Value: JSON { otpHash, attempts, maxAttempts, resendAt, extraData }
```

---

## 12. Port Map & Service URLs

| Service | Port | Ghi chú |
|---|---|---|
| Next.js FE | 5173 (dev) | NEXT_PUBLIC_API_URL = http://localhost:3000 |
| API Gateway | 3000 | Entry point duy nhất cho tất cả API calls |
| Auth Service | 3001 | Chỉ nhận request từ API Gateway (internal) |
| Keycloak | 8080 | Admin: admin / ngocanh321, Realm: bin-ecommerce |
| PostgreSQL | 5432 | DB: bin_ecommerce_auth |
| Redis | 6379 | OTP storage |

---

## 13. RBAC — Phân quyền

Role được lưu trong **Keycloak realm roles** và đồng bộ vào `users.role` trong PostgreSQL.

| Role | Mô tả |
|---|---|
| `CUSTOMER` | Người dùng thông thường (mặc định khi đăng ký) |
| `STAFF` | Nhân viên (quản lý đơn hàng, kho) |
| `ADMIN` | Quản trị viên toàn hệ thống |

**Cách hoạt động:**
1. Keycloak embed roles vào JWT payload (`realm_access.roles`)
2. `JwksService.verifyToken()` extract ra `roles: string[]`
3. `JwtAuthGuard` inject `x-user-roles: "CUSTOMER"` vào header
4. Downstream services đọc `x-user-roles` để kiểm tra quyền
