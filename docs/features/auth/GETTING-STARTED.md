# Bin E-Commerce — Getting Started

## 1. Yêu cầu

| Tool                    | Version |
| ----------------------- | ------- |
| Node.js                 | ≥ 20    |
| Docker & Docker Compose | ≥ 24    |
| npm                     | ≥ 10    |

---

## 2. Khởi động hạ tầng (Postgres, Redis, Kafka, Keycloak)

```bash
# Từ root của repo
docker compose --env-file .env -f infra/docker/docker-compose.infra.yml up -d
```

Chờ các service healthy (khoảng 30–60 giây). Kiểm tra:

```bash
docker compose -f infra/docker/docker-compose.infra.yml ps
```

Các cổng mặc định:

| Service           | Port |
| ----------------- | ---- |
| PostgreSQL        | 5432 |
| Redis             | 6379 |
| Kafka             | 9092 |
| Keycloak Admin UI | 8080 |

---

## 3. Cấu hình Keycloak (làm một lần)

Mở `http://localhost:8080` → đăng nhập `admin / changeme_admin`.

### 3.1 Tạo Realm

1. Nhấn **Create realm** → Name: `bin-ecommerce` → **Create**

### 3.2 Tạo 10 Realm Roles

**Realm settings → Roles → Create role** (lần lượt tạo từng role):

```
CUSTOMER  CATALOG_MANAGER  INVENTORY_MANAGER  ORDER_MANAGER
SHIPPING_MANAGER  PROMOTION_MANAGER  RETURN_MANAGER
ANALYST  SUPPORT_AGENT  ADMIN
```

### 3.3 Tạo Client `auth-service` (ROPC)

**Clients → Create client**

| Field                 | Value                             |
| --------------------- | --------------------------------- |
| Client ID             | `auth-service`                    |
| Client authentication | ON                                |
| Authorization         | OFF                               |
| Authentication flow   | chỉ tick **Direct access grants** |

Sau khi save → tab **Credentials** → copy `Client secret` → điền vào `services/auth-service/.env`:

```
KEYCLOAK_CLIENT_ID=auth-service
KEYCLOAK_CLIENT_SECRET=<secret vừa copy>
```

### 3.4 Tạo Client `auth-service-admin` (Admin API)

**Clients → Create client**

| Field                 | Value                               |
| --------------------- | ----------------------------------- |
| Client ID             | `auth-service-admin`                |
| Client authentication | ON                                  |
| Authentication flow   | chỉ tick **Service accounts roles** |

Tab **Service accounts roles** → **Assign role** → filter by client `realm-management` → assign:

- `manage-users`
- `view-users`
- `manage-realm`

Tab **Credentials** → copy secret → điền vào `.env`:

```
KEYCLOAK_ADMIN_CLIENT_ID=auth-service-admin
KEYCLOAK_ADMIN_CLIENT_SECRET=<secret vừa copy>
```

### 3.5 Tạo Client `web-client` (PKCE / Frontend)

| Field                 | Value                     |
| --------------------- | ------------------------- |
| Client ID             | `web-client`              |
| Client authentication | OFF                       |
| Authentication flow   | tick **Standard flow**    |
| Valid redirect URIs   | `http://localhost:3001/*` |
| Web origins           | `http://localhost:3001`   |

### 3.6 Thêm Roles Mapper vào `auth-service`

**Clients → auth-service → Client scopes → auth-service-dedicated → Add mapper → By configuration → User Realm Role**

| Field               | Value    |
| ------------------- | -------- |
| Name                | `roles`  |
| Token Claim Name    | `roles`  |
| Claim JSON Type     | `String` |
| Add to access token | ON       |
| Add to ID token     | ON       |

### 3.7 Đặt default role

**Realm settings → User registration → Default roles** → Add `CUSTOMER`

---

## 4. Cài dependencies & chạy local

```bash
# Root
npm install

# Auth service
cd services/auth-service
npm install
npm run dev

# API Gateway (terminal khác)
cd services/api-gateway
npm install
npm run dev
```

Sau khi khởi động:

- API Gateway: `http://localhost:3000`
- Auth Service: `http://localhost:3001` (không expose ra ngoài, gateway proxy)

---

## 5. Luồng hoạt động Auth

### 5.1 Đăng ký (Register)

```
Client
  │
  ├─ POST /api/v1/auth/register/initiate
  │    body: { email, password, name, phone? }
  │    ↓
  │   AuthService.registerInitiate()
  │    ├─ Kiểm tra email đã tồn tại chưa (PostgreSQL)
  │    ├─ Tạo OTP 6 số (cryptographically random)
  │    ├─ Lưu Redis: key=otp:REGISTER:<email>
  │    │    hash: { otp_hash(SHA-256), resend_at, attempts, extra_data(name,phone,password) }
  │    │    TTL: 600s (10 phút)
  │    └─ [DEV] Log OTP ra console (PROD: gửi email)
  │
  ├─ POST /api/v1/auth/register/verify
  │    body: { identifier: email, otp: "123456" }
  │    ↓
  │   AuthService.registerVerify()
  │    ├─ OtpService.verifyOtp() — kiểm tra hash, attempts, TTL
  │    ├─ KeycloakAdminService.createUser() — tạo user trên Keycloak
  │    ├─ UserRepo.save() — tạo user trong PostgreSQL
  │    │    └─ Nếu DB lỗi → xoá Keycloak user (compensate)
  │    ├─ KeycloakAdminService.assignRealmRole(CUSTOMER)
  │    ├─ TokenService.issueTokenPair() — ROPC với Keycloak
  │    └─ Trả về { accessToken, refreshToken, expiresIn, user }
```

### 5.2 Đăng nhập (Login)

```
Client
  │
  ├─ POST /api/v1/auth/login
  │    body: { email, password }
  │    ↓
  │   TokenService.issueTokenPair()
  │    ├─ POST Keycloak /token (grant_type=password)
  │    ├─ Lưu refresh token hash vào PostgreSQL (bảng refresh_tokens)
  │    └─ Trả về { accessToken, refreshToken, expiresIn, user }
```

### 5.3 Refresh Token (rotation + theft detection)

```
Client
  │
  ├─ POST /api/v1/auth/refresh
  │    body: { refreshToken: "<token>" }
  │    ↓
  │   AuthService.refresh()
  │    ├─ Hash token đầu vào (SHA-256)
  │    ├─ Tìm bản ghi trong refresh_tokens theo hash
  │    ├─ Nếu đã bị revoked → XOÁ toàn bộ token của user (theft detected!)
  │    ├─ Nếu hết hạn → 401
  │    ├─ Revoke token cũ
  │    ├─ POST Keycloak /token (grant_type=refresh_token)
  │    └─ Lưu token mới + trả về cặp token mới
```

### 5.4 Social Login (Google / Facebook)

```
Client
  │
  ├─ GET /api/v1/auth/social/start/google
  │    ↓ Keycloak redirect URL kèm state UUID (CSRF protection)
  │
  ├─ [User đăng nhập Google]
  │
  ├─ POST /api/v1/auth/social/callback/google
  │    body: { code, state }
  │    ↓
  │   TokenService.exchangeCode() — exchange auth code lấy token
  │    └─ Trả về token pair
```

---

## 6. Luồng hoạt động RBAC

```
Client
  │
  ├─ Request kèm: Authorization: Bearer <access_token>
  │
  ├─► API Gateway (port 3000)
  │     │
  │     ├─ JwtAuthGuard (APP_GUARD #1)
  │     │   ├─ Nếu route có @Public() → PASS (không check token)
  │     │   ├─ Decode JWT → lấy kid → fetch public key từ JWKS endpoint Keycloak
  │     │   ├─ Verify chữ ký RS256 + issuer
  │     │   └─ Inject vào headers:
  │     │       x-user-id    = payload.sub
  │     │       x-user-email = payload.email
  │     │       x-user-roles = "CUSTOMER,ADMIN" (comma-separated)
  │     │
  │     ├─ RolesGuard (APP_GUARD #2)
  │     │   ├─ Nếu @Public() → PASS
  │     │   ├─ Nếu không có @Roles() metadata → PASS (auth-only route)
  │     │   ├─ Nếu user có role ADMIN → PASS (bypass tất cả)
  │     │   └─ Kiểm tra giao giữa x-user-roles và @Roles(...)
  │     │       ├─ Có giao → PASS
  │     │       └─ Không có → 403 Forbidden
  │     │
  │     └─ ProxyService.forward() → downstream service
  │           kèm headers x-user-* đã inject
  │
  └─► Auth Service / Product Service / ...
        └─ Đọc x-user-id từ header (trust gateway)
```

### Bảng phân quyền theo route

| Route prefix            | Guard       | Roles được phép   |
| ----------------------- | ----------- | ----------------- |
| `POST /auth/register/*` | `@Public()` | Tất cả            |
| `POST /auth/login`      | `@Public()` | Tất cả            |
| `POST /auth/refresh`    | `@Public()` | Tất cả            |
| `GET /auth/social/*`    | `@Public()` | Tất cả            |
| `POST /auth/logout`     | JWT only    | Đăng nhập         |
| `GET /users/me`         | JWT only    | Đăng nhập         |
| `GET /products`         | `@Public()` | Tất cả            |
| `GET /categories`       | `@Public()` | Tất cả            |
| `GET /cart`             | JWT only    | Đăng nhập         |
| `GET /orders`           | JWT only    | Đăng nhập         |
| `GET /admin/products`   | `@Roles()`  | CATALOG_MANAGER   |
| `GET /admin/orders`     | `@Roles()`  | ORDER_MANAGER     |
| `GET /admin/inventory`  | `@Roles()`  | INVENTORY_MANAGER |
| `GET /admin/users`      | `@Roles()`  | SUPPORT_AGENT     |
| Tất cả admin routes     | Override    | ADMIN bypass hết  |

---

## 7. Test thủ công bằng curl / Postman

> **Base URL**: `http://localhost:3000/api/v1`

### 7.1 Đăng ký

**Bước 1 — Initiate:**

```bash
curl -X POST http://localhost:3000/api/v1/auth/register/initiate \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Password1",
    "name": "Nguyen Van A",
    "phone": "0901234567"
  }'
```

Kết quả mong đợi: `200 { "message": "OTP sent to your email", "expiresIn": 600 }`

Xem OTP trong console của auth-service: `[DEV OTP] EMAIL → test@example.com: 123456`

**Bước 2 — Verify:**

```bash
curl -X POST http://localhost:3000/api/v1/auth/register/verify \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "test@example.com",
    "otp": "123456"
  }'
```

Kết quả mong đợi: `201 { "accessToken": "...", "refreshToken": "...", "expiresIn": 900, "user": {...} }`

### 7.2 Đăng nhập

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Password1"
  }'
```

Lưu `accessToken` và `refreshToken` từ response.

### 7.3 Truy cập route protected

```bash
# Thay <ACCESS_TOKEN> bằng token vừa nhận
curl http://localhost:3000/api/v1/users/me \
  -H "Authorization: Bearer <ACCESS_TOKEN>"
```

Kết quả mong đợi: `200` với thông tin user.

```bash
# Không có token → 401
curl http://localhost:3000/api/v1/users/me
```

### 7.4 Test RBAC — route admin cần role

```bash
# Dùng token CUSTOMER thường → 403
curl http://localhost:3000/api/v1/admin/products \
  -H "Authorization: Bearer <CUSTOMER_TOKEN>"

# Kết quả: 403 Forbidden
```

Để test với ADMIN role, vào Keycloak → Users → tìm user → Role Mappings → assign role `ADMIN` → login lại lấy token mới.

### 7.5 Refresh token

```bash
curl -X POST http://localhost:3000/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "<REFRESH_TOKEN>" }'
```

Kết quả mong đợi: cặp token mới. Token cũ bị revoke ngay lập tức.

**Test theft detection:**

```bash
# Dùng refresh token cũ lần 2 → 401 + toàn bộ session bị xoá
curl -X POST http://localhost:3000/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "<OLD_REFRESH_TOKEN>" }'
```

### 7.6 Logout

```bash
curl -X POST http://localhost:3000/api/v1/auth/logout \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "<REFRESH_TOKEN>" }'
```

### 7.7 Test resend cooldown OTP

```bash
# Gửi initiate lần 2 trong vòng 60 giây → 429
curl -X POST http://localhost:3000/api/v1/auth/register/initiate \
  -H "Content-Type: application/json" \
  -d '{ "email": "test@example.com", "password": "Password1", "name": "Test" }'

# Kết quả: 429 "Please wait 55s before requesting a new OTP"
```

### 7.8 Test brute-force OTP (max 3 lần)

```bash
# Gửi sai OTP 3 lần liên tiếp
for i in 1 2 3; do
  curl -X POST http://localhost:3000/api/v1/auth/register/verify \
    -H "Content-Type: application/json" \
    -d '{ "identifier": "test@example.com", "otp": "000000" }'
done

# Lần 4: 429 "Maximum OTP attempts exceeded"
```

### 7.9 Kiểm tra Redis trực tiếp

```bash
docker exec -it <redis-container> redis-cli

# Xem tất cả key OTP
KEYS otp:*

# Xem nội dung challenge
HGETALL otp:REGISTER:test@example.com

# Xem TTL còn lại (giây)
TTL otp:REGISTER:test@example.com
```

### 7.10 Test public routes (không cần token)

```bash
# Products — public
curl http://localhost:3000/api/v1/products

# Categories — public
curl http://localhost:3000/api/v1/categories

# Kết quả: forward đến product-service (sẽ trả lỗi nếu service chưa chạy,
# nhưng gateway không chặn → chứng minh @Public() hoạt động)
```

---

## 8. Chạy toàn bộ stack bằng Docker Compose

```bash
# Bước 1: build images
docker compose build

# Bước 2: khởi động infra
docker compose -f infra/docker/docker-compose.infra.yml up -d

# Bước 3: khởi động services
docker compose up -d

# Xem logs
docker compose logs -f api-gateway auth-service
```

---

## 9. Biến môi trường cần điền trước khi chạy

### `services/auth-service/.env`

| Biến                           | Mô tả                                                 |
| ------------------------------ | ----------------------------------------------------- |
| `POSTGRES_PASSWORD`            | Password PostgreSQL                                   |
| `KEYCLOAK_CLIENT_SECRET`       | Secret của client `auth-service` (lấy từ Keycloak UI) |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | Secret của client `auth-service-admin`                |

### `services/api-gateway/.env`

Chỉ cần đảm bảo `KEYCLOAK_URL` và `KEYCLOAK_REALM` khớp với Keycloak đang chạy. Các service URL dùng `localhost` khi chạy local.
