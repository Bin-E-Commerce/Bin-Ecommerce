# Auth Feature & Keycloak Setup Guide

> Hướng dẫn chức năng xác thực và cách cấu hình Keycloak thủ công qua Admin UI (không dùng file `bin-ecommerce-realm.json`).

---

## Mục lục

1. [Tổng quan kiến trúc](#1-tổng-quan-kiến-trúc)
2. [Chức năng Auth](#2-chức-năng-auth)
3. [Hệ thống phân quyền RBAC](#3-hệ-thống-phân-quyền-rbac)
4. [Cấu hình Keycloak thủ công](#4-cấu-hình-keycloak-thủ-công)
5. [Biến môi trường](#5-biến-môi-trường)
6. [Flow chi tiết các chức năng](#6-flow-chi-tiết-các-chức-năng)

---

## 1. Tổng quan kiến trúc

```
Client
  │
  ▼
API Gateway (:3000)          ← verify JWT (RS256 via JWKS), inject x-user-* headers
  │
  ├── /api/v1/auth/*    ──►  Auth Service (:3001)   ← Keycloak ROPC / Auth Code
  ├── /api/v1/users/*   ──►  Auth Service (:3001)
  └── /api/v1/...       ──►  Downstream services
                                    ▲
                                    │ trusts x-user-id, x-user-email, x-user-roles headers
```

**Luồng xác thực JWT tại API Gateway:**

1. `JwtAuthGuard` xác minh JWT bằng JWKS endpoint của Keycloak (`RS256`)
2. Inject `x-user-id`, `x-user-email`, `x-user-roles` vào request header
3. `RolesGuard` đọc `x-user-roles` và kiểm tra `@Roles()` metadata
4. Forward request đến service tương ứng kèm theo headers

---

## 2. Chức năng Auth

### 2.1 Đăng ký (Email + OTP)

**Bước 1 — Khởi tạo đăng ký**

```
POST /api/v1/auth/register/initiate
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "Password123",
  "name": "Nguyen Van A",
  "phone": "0912345678"       // optional, định dạng VN
}
```

**Response:**

```json
{
  "data": { "message": "OTP sent to your email", "expiresIn": 600 },
  "statusCode": 200
}
```

- Kiểm tra email chưa tồn tại trong DB
- Tạo OTP 6 chữ số, hết hạn sau **10 phút**, cooldown gửi lại **60 giây**
- OTP hash (SHA-256) lưu vào bảng `otp_challenges`
- Thông tin đăng ký (`name`, `phone`, `passwordForKc`) lưu tạm trong `extra_data`

**Bước 2 — Xác minh OTP**

```
POST /api/v1/auth/register/verify
Content-Type: application/json

{
  "identifier": "user@example.com",
  "otp": "123456"
}
```

**Response:**

```json
{
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "expiresIn": 300,
    "user": { "id": "uuid", "email": "...", "name": "...", "role": "CUSTOMER" }
  },
  "statusCode": 201
}
```

- Verify OTP (max 3 lần sai → khóa challenge)
- Tạo user trên Keycloak
- Insert user vào DB local (compensate Keycloak nếu lỗi)
- Gán role `CUSTOMER` trên Keycloak
- Trả về access token + refresh token

---

### 2.2 Đăng nhập (Email + Password)

```
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "Password123"
}
```

- Gọi Keycloak ROPC grant (`grant_type=password`)
- Kiểm tra user `ACTIVE` trong DB local
- Cập nhật `last_login_at`
- Lưu refresh token (hash SHA-256) vào DB kèm IP + User-Agent

---

### 2.3 Refresh Token

```
POST /api/v1/auth/refresh
Content-Type: application/json

{ "refreshToken": "eyJ..." }
```

- Tìm refresh token theo SHA-256 hash trong DB
- Nếu token đã bị revoke → **revoke toàn bộ** refresh tokens của user (phát hiện token theft)
- Gọi Keycloak `grant_type=refresh_token` để lấy token mới
- Revoke token cũ, lưu token mới

---

### 2.4 Đăng xuất

```
POST /api/v1/auth/logout
Authorization: Bearer <access_token>

{ "refreshToken": "eyJ..." }
```

- Đánh dấu `revoked_at` trong DB
- Gọi Keycloak revoke endpoint (lỗi bị bỏ qua)

---

### 2.5 Đăng nhập Google / Facebook

**Bước 1 — Lấy URL đăng nhập**

```
GET /api/v1/auth/social/start/google
GET /api/v1/auth/social/start/facebook
```

**Response:**

```json
{
  "data": {
    "authUrl": "https://keycloak.example.com/realms/bin-ecommerce/protocol/openid-connect/auth?...",
    "state": "uuid-csrf-token"
  }
}
```

- Tạo CSRF state (UUID), lưu in-memory với TTL 10 phút
- URL gồm `kc_idp_hint=google` hoặc `kc_idp_hint=facebook` để Keycloak redirect thẳng đến IdP

**Bước 2 — Callback sau khi user authorize**

```
POST /api/v1/auth/social/callback/google
Content-Type: application/json

{ "code": "auth-code-from-keycloak", "state": "uuid-csrf-token" }
```

- Verify CSRF state
- Keycloak đổi `code` → token pair (authorization_code grant)
- Decode `id_token` để lấy thông tin user (`sub`, `email`, `name`)
- Upsert user trong DB (tìm theo `keycloakId`, fallback theo `email`)
- Trả về access token + refresh token

---

### 2.6 Quản lý Profile (yêu cầu đăng nhập)

```
GET  /api/v1/users/me                         ← lấy thông tin cá nhân
PUT  /api/v1/users/me                         ← cập nhật name, phone, avatarUrl
GET  /api/v1/users/me/addresses               ← danh sách địa chỉ (tối đa 5)
POST /api/v1/users/me/addresses               ← thêm địa chỉ mới
PUT  /api/v1/users/me/addresses/:id           ← cập nhật địa chỉ
DELETE /api/v1/users/me/addresses/:id         ← xóa địa chỉ
```

---

### 2.7 Admin User Management (ADMIN / SUPPORT_AGENT)

```
GET /api/v1/admin/users?page=1&limit=20       ← danh sách users (SUPPORT_AGENT trở lên)
PUT /api/v1/admin/users/:id/role              ← đổi role (ADMIN only)
PUT /api/v1/admin/users/:id/status            ← đổi trạng thái (ADMIN only)
```

```json
// PUT /admin/users/:id/role
{ "role": "ORDER_MANAGER" }

// PUT /admin/users/:id/status
{ "status": "BANNED" }
```

- Không thể tự đổi role/status của chính mình
- Cập nhật đồng bộ cả Keycloak (remove old role → assign new role) và DB local

---

## 3. Hệ thống phân quyền RBAC

### 10 roles hardcoded

| Role                | Mô tả              | Phạm vi                                                  |
| ------------------- | ------------------ | -------------------------------------------------------- |
| `CUSTOMER`          | Khách hàng         | Mua hàng, quản lý đơn, địa chỉ                           |
| `CATALOG_MANAGER`   | Quản lý sản phẩm   | `/admin/products`, `/admin/categories`, `/admin/reviews` |
| `INVENTORY_MANAGER` | Quản lý kho        | `/admin/inventory`                                       |
| `ORDER_MANAGER`     | Quản lý đơn hàng   | `/admin/orders`                                          |
| `SHIPPING_MANAGER`  | Quản lý vận chuyển | `/admin/shipments`                                       |
| `PROMOTION_MANAGER` | Quản lý khuyến mãi | `/admin/promotions`, `/admin/vouchers`                   |
| `RETURN_MANAGER`    | Quản lý hoàn trả   | `/admin/returns`                                         |
| `ANALYST`           | Phân tích dữ liệu  | `/admin/analytics`                                       |
| `SUPPORT_AGENT`     | CSKH               | `/admin/users` (read only)                               |
| `ADMIN`             | Toàn quyền         | Bypass tất cả role checks                                |

### Cách hoạt động tại API Gateway

```
Request → JwtAuthGuard (verify RS256 JWT)
                │
                ├─ inject x-user-roles: "ORDER_MANAGER"
                ▼
         RolesGuard
                │
                ├─ @Public()? → pass
                ├─ @Roles() metadata empty? → pass (auth only)
                ├─ x-user-roles contains ADMIN? → pass
                └─ intersection(userRoles, requiredRoles) > 0? → pass / 403
```

### Sử dụng trong controller

```typescript
// Cho phép một role cụ thể
@Roles(UserRole.ORDER_MANAGER)
@Controller('admin/orders')

// Cho phép nhiều roles
@Roles(UserRole.SUPPORT_AGENT, UserRole.ADMIN)
@Get()

// Route public (không cần JWT)
@Public()
@Get('products')
```

---

## 4. Cấu hình Keycloak thủ công

### Yêu cầu

- Keycloak 24+ đang chạy (mặc định `http://localhost:8080`)
- Tài khoản admin Keycloak

---

### Bước 1 — Tạo Realm

1. Đăng nhập Keycloak Admin UI: `http://localhost:8080/admin`
2. Hover vào tên realm hiện tại (góc trên trái) → **Create realm**
3. Điền:
   - **Realm name**: `bin-ecommerce`
   - **Enabled**: ON
4. Nhấn **Create**

---

### Bước 2 — Tạo 10 Realm Roles

Vào **Realm roles** (menu trái) → **Create role** cho từng role sau:

| Role name           | Description                     |
| ------------------- | ------------------------------- |
| `CUSTOMER`          | Default customer role           |
| `CATALOG_MANAGER`   | Manages products and categories |
| `INVENTORY_MANAGER` | Manages inventory               |
| `ORDER_MANAGER`     | Manages orders                  |
| `SHIPPING_MANAGER`  | Manages shipments               |
| `PROMOTION_MANAGER` | Manages promotions and vouchers |
| `RETURN_MANAGER`    | Manages return requests         |
| `ANALYST`           | Analytics access                |
| `SUPPORT_AGENT`     | Customer support                |
| `ADMIN`             | Full system access              |

Lặp lại 10 lần: nhấn **Create role** → nhập tên → **Save**.

**Cấu hình ADMIN là composite role** (tùy chọn, để ADMIN tự động có tất cả quyền):

1. Vào role `ADMIN` → tab **Associated roles**
2. **Assign roles** → chọn tất cả 9 roles còn lại → **Assign**

---

### Bước 3 — Tạo Client `api-gateway` (Backend ROPC)

1. Vào **Clients** → **Create client**
2. **General settings**:
   - **Client ID**: `api-gateway`
   - **Client type**: `OpenID Connect`
3. **Capability config**:
   - **Client authentication**: ON _(tạo client secret)_
   - **Authorization**: OFF
   - **Authentication flow**: chọn **Direct access grants** (ROPC) ✓
   - Bỏ chọn **Standard flow** (không cần cho backend)
4. **Login settings**: để trống redirect URIs
5. **Save**

**Lấy client secret:**

- Vào tab **Credentials** → copy **Client secret**
- Đây là giá trị `KEYCLOAK_CLIENT_SECRET` và `KEYCLOAK_ADMIN_CLIENT_SECRET`

**Cấp quyền Service Account để gọi Admin API:**

1. Tab **Service accounts roles** → **Assign role**
2. Filter: **Filter by clients** → chọn `realm-management`
3. Assign các roles sau:
   - `manage-users`
   - `view-users`
   - `manage-realm`
   - `query-users`
4. **Assign**

---

### Bước 4 — Tạo Client `web-client` (Frontend PKCE)

1. **Clients** → **Create client**
2. **General settings**:
   - **Client ID**: `web-client`
   - **Client type**: `OpenID Connect`
3. **Capability config**:
   - **Client authentication**: OFF _(public client)_
   - **Authentication flow**: chọn **Standard flow** ✓ (Authorization Code + PKCE)
   - Bỏ **Direct access grants**
4. **Login settings**:
   - **Valid redirect URIs**: `http://localhost:3000/auth/callback` _(thêm prod URL sau)_
   - **Valid post logout redirect URIs**: `http://localhost:3000`
   - **Web origins**: `http://localhost:3000`
5. **Save**

**Bật PKCE (bảo mật cho SPA):**

1. Tab **Advanced** → **Advanced settings**
2. **Proof Key for Code Exchange Code Challenge Method**: `S256`
3. **Save**

---

### Bước 5 — Cấu hình `roles` Mapper (JWT claim)

Keycloak mặc định đặt roles vào `realm_access.roles`. Backend cần claim `roles` ở root level.

**Tạo mapper cho client `api-gateway`:**

1. Vào client `api-gateway` → tab **Client scopes**
2. Nhấn vào `api-gateway-dedicated` → **Add mapper** → **By configuration**
3. Chọn **User Realm Role**
4. Điền:
   - **Name**: `realm-roles`
   - **Token Claim Name**: `roles`
   - **Claim JSON Type**: `String`
   - **Add to ID token**: ON
   - **Add to access token**: ON
   - **Add to userinfo**: ON
   - **Multivalued**: ON
5. **Save**

Lặp lại cho client `web-client`.

---

### Bước 6 — Đặt Default Role cho User mới

1. Vào **Realm settings** → tab **User registration**
2. **Default roles** → **Assign role**
3. Chọn `CUSTOMER` → **Assign**

Mọi user mới tạo sẽ tự động có role `CUSTOMER`.

---

### Bước 7 — Cấu hình Google Identity Provider

1. Vào **Identity providers** → **Add provider** → **Google**
2. Điền:
   - **Client ID**: _(Google OAuth2 Client ID từ Google Cloud Console)_
   - **Client Secret**: _(Google OAuth2 Client Secret)_
   - **Display name**: `Google`
   - **Alias**: `google` _(phải khớp với `kc_idp_hint=google` trong code)_
3. **Advanced settings**:
   - **Sync mode**: `FORCE`
4. **Save**

**Thêm Redirect URI vào Google Cloud Console:**

- Vào Google Cloud → APIs & Services → Credentials → OAuth 2.0 Client
- **Authorized redirect URIs**: thêm `http://localhost:8080/realms/bin-ecommerce/broker/google/endpoint`

---

### Bước 8 — Cấu hình Facebook Identity Provider

1. **Identity providers** → **Add provider** → **Facebook**
2. Điền:
   - **Client ID**: _(Facebook App ID)_
   - **Client Secret**: _(Facebook App Secret)_
   - **Alias**: `facebook`
3. **Save**

**Thêm OAuth Redirect URI vào Facebook Developer Console:**

- `http://localhost:8080/realms/bin-ecommerce/broker/facebook/endpoint`

---

### Bước 9 — Cấu hình Token Lifetime

1. Vào **Realm settings** → tab **Tokens**
2. Điều chỉnh:
   - **Access Token Lifespan**: `5 minutes` _(mặc định 5 phút, đủ ngắn để bảo mật)_
   - **SSO Session Idle**: `30 minutes`
   - **SSO Session Max**: `10 hours`
   - **Refresh Token Max Reuse**: `0` _(tắt reuse — backend tự quản lý rotation)_
   - **Offline Session Idle**: `30 days`
3. **Save**

---

### Bước 10 — Kiểm tra cấu hình

**Test JWKS endpoint** (dùng bởi API Gateway):

```bash
curl http://localhost:8080/realms/bin-ecommerce/protocol/openid-connect/certs
```

Phải trả về JSON chứa mảng `keys` với RSA public key.

**Test ROPC login:**

```bash
curl -X POST http://localhost:8080/realms/bin-ecommerce/protocol/openid-connect/token \
  -d "grant_type=password" \
  -d "client_id=api-gateway" \
  -d "client_secret=<SECRET>" \
  -d "username=test@example.com" \
  -d "password=Test1234" \
  -d "scope=openid"
```

Phải trả về `access_token`, `refresh_token`, `expires_in`.

**Kiểm tra claim `roles` trong JWT:**

```bash
# Decode access_token (phần thứ 2 sau dấu chấm)
echo "<JWT_PAYLOAD_BASE64>" | base64 -d | python3 -m json.tool
```

Phải thấy `"roles": ["CUSTOMER"]` ở root level.

---

## 5. Biến môi trường

### Auth Service (`services/auth-service/.env`)

```env
# Database
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=auth_user
POSTGRES_PASSWORD=auth_password
POSTGRES_DB=auth_db

# Keycloak — Token operations (ROPC, refresh, revoke)
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=bin-ecommerce
KEYCLOAK_CLIENT_ID=api-gateway
KEYCLOAK_CLIENT_SECRET=<lấy từ client api-gateway → Credentials>

# Keycloak — Admin operations (tạo user, gán role)
KEYCLOAK_ADMIN_CLIENT_ID=api-gateway
KEYCLOAK_ADMIN_CLIENT_SECRET=<cùng secret ở trên>

# Social login
KEYCLOAK_WEB_CLIENT_ID=web-client
FRONTEND_URL=http://localhost:3000

# App
NODE_ENV=development
PORT=3001
```

### API Gateway (`services/api-gateway/.env`)

```env
# Keycloak — JWKS để verify JWT
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=bin-ecommerce

# Downstream services
AUTH_SERVICE_URL=http://localhost:3001
PRODUCT_SERVICE_URL=http://localhost:3002
CART_SERVICE_URL=http://localhost:3003
ORDER_SERVICE_URL=http://localhost:3004
INVENTORY_SERVICE_URL=http://localhost:3005
NOTIFICATION_SERVICE_URL=http://localhost:3006
SHIPPING_SERVICE_URL=http://localhost:3007
PROMOTION_SERVICE_URL=http://localhost:3008
RETURN_SERVICE_URL=http://localhost:3009

NODE_ENV=development
PORT=3000
```

---

## 6. Flow chi tiết các chức năng

### Đăng ký với OTP

```
Client          API Gateway      Auth Service       Keycloak         DB
  │                 │                │                 │              │
  │ POST /register  │                │                 │              │
  │  /initiate      │                │                 │              │
  ├────────────────►│ (Public route) │                 │              │
  │                 ├───────────────►│                 │              │
  │                 │                │ check email     │              │
  │                 │                ├────────────────────────────────►
  │                 │                │◄────────────────────────────────
  │                 │                │ create OTP      │              │
  │                 │                ├────────────────────────────────►
  │◄────────────────┤◄───────────────┤ OTP sent (200)  │              │
  │                 │                │                 │              │
  │ POST /register  │                │                 │              │
  │  /verify        │                │                 │              │
  ├────────────────►│ (Public route) │                 │              │
  │                 ├───────────────►│                 │              │
  │                 │                │ verify OTP      │              │
  │                 │                │ createUser ─────►              │
  │                 │                │ keycloakId ◄────┤              │
  │                 │                │ insert user ────────────────────►
  │                 │                │ assignRole ─────►              │
  │                 │                │ issueTokenPair ─►              │
  │◄────────────────┤◄───────────────┤ {tokens, user} (201)          │
```

### Refresh Token với phát hiện theft

```
Client          API Gateway      Auth Service                    DB
  │                 │                │                             │
  │ POST /refresh   │                │                             │
  ├────────────────►│ (Public route) │                             │
  │                 ├───────────────►│                             │
  │                 │                │ find by SHA256(token) ──────►
  │                 │                │◄────────────────────────────┤
  │                 │                │                             │
  │                 │                │ if revoked_at != null:      │
  │                 │                │   revoke ALL user tokens ───►
  │                 │                │   return 401 Unauthorized   │
  │                 │                │                             │
  │                 │                │ if valid:                   │
  │                 │                │   rotateRefreshToken ──► Keycloak
  │                 │                │   revoke old token ─────────►
  │                 │                │   save new token ───────────►
  │◄────────────────┤◄───────────────┤ {newTokens} (200)           │
```

---

> **Lưu ý bảo mật:**
>
> - `extra_data` trong `otp_challenges` lưu `passwordForKc` tạm thời dạng JSON plaintext. Record tự xóa sau khi verify thành công hoặc 10 phút. Cần mã hóa (AES-256-GCM) trước khi lên production.
> - Không commit `.env` files. Dùng Vault hoặc AWS Secrets Manager cho production.
> - `KEYCLOAK_ADMIN_CLIENT_SECRET` có quyền tạo/xóa user — cần giữ bí mật tuyệt đối.
