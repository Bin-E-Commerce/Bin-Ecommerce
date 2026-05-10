# 🔐 Domain: Auth & User Management

> **Service:** `auth-service` — Port `3001`
> **Database:** AWS RDS PostgreSQL — schema `auth`
> **Identity Provider:** Keycloak 24 (Realm: `ecommerce`)
> **Cập nhật:** 22/04/2026

---

## Mục Lục

1. [Tổng Quan Domain](#1-tổng-quan-domain)
2. [Entities & Data Model](#2-entities--data-model)
3. [Business Rules](#3-business-rules)
4. [API Contract](#4-api-contract)
5. [State Machine — User Account](#5-state-machine--user-account)
6. [Luồng Nghiệp Vụ](#6-luồng-nghiệp-vụ)
7. [Validation Rules](#7-validation-rules)
8. [Error Catalog](#8-error-catalog)
9. [Security Requirements](#9-security-requirements)

---

## 1. Tổng Quan Domain

| Trách nhiệm       | Mô tả                                                     |
| ----------------- | --------------------------------------------------------- |
| Đăng ký tài khoản | Tạo user trong hệ thống + đồng bộ sang Keycloak           |
| Xác thực          | Cấp JWT Access Token + Refresh Token qua Keycloak OIDC    |
| Phân quyền        | Quản lý roles `USER` / `ADMIN`, bảo vệ endpoint theo role |
| Quản lý phiên     | Refresh token, logout, revoke session                     |
| Thông tin cá nhân | Đọc/sửa profile (tên, SĐT, avatar), quản lý địa chỉ       |

**Ngoài phạm vi domain này:**

- Giỏ hàng, đơn hàng, sản phẩm (domain khác)
- Email welcome (Notification Service consume `user.registered` Kafka event)

---

## 2. Entities & Data Model

### 2.1 Entity: `users`

| Column          | Type                                 | Constraint                    | Mô tả                         |
| --------------- | ------------------------------------ | ----------------------------- | ----------------------------- |
| `id`            | `UUID`                               | PK, DEFAULT gen_random_uuid() | Primary key                   |
| `email`         | `VARCHAR(255)`                       | UNIQUE NOT NULL               | Email đăng nhập (lowercase)   |
| `name`          | `VARCHAR(100)`                       | NOT NULL                      | Tên hiển thị                  |
| `phone`         | `VARCHAR(20)`                        | NULLABLE                      | Số điện thoại                 |
| `keycloak_id`   | `VARCHAR(36)`                        | UNIQUE NOT NULL               | UUID từ Keycloak              |
| `role`          | `ENUM('USER','ADMIN')`               | NOT NULL DEFAULT 'USER'       | Vai trò                       |
| `status`        | `ENUM('ACTIVE','INACTIVE','BANNED')` | NOT NULL DEFAULT 'ACTIVE'     | Trạng thái                    |
| `avatar_url`    | `TEXT`                               | NULLABLE                      | URL ảnh đại diện (Cloudinary) |
| `last_login_at` | `TIMESTAMPTZ`                        | NULLABLE                      | Lần đăng nhập cuối            |
| `created_at`    | `TIMESTAMPTZ`                        | NOT NULL DEFAULT NOW()        |                               |
| `updated_at`    | `TIMESTAMPTZ`                        | NOT NULL DEFAULT NOW()        |                               |

```sql
CREATE UNIQUE INDEX idx_users_email        ON users(email);
CREATE UNIQUE INDEX idx_users_keycloak_id  ON users(keycloak_id);
CREATE        INDEX idx_users_status       ON users(status);
```

---

### 2.2 Entity: `user_addresses`

| Column       | Type           | Constraint                      | Mô tả                                |
| ------------ | -------------- | ------------------------------- | ------------------------------------ |
| `id`         | `UUID`         | PK                              |                                      |
| `user_id`    | `UUID`         | FK → users.id ON DELETE CASCADE |                                      |
| `label`      | `VARCHAR(50)`  | NOT NULL                        | "Nhà", "Văn phòng"                   |
| `full_name`  | `VARCHAR(100)` | NOT NULL                        | Tên người nhận                       |
| `phone`      | `VARCHAR(20)`  | NOT NULL                        | SĐT người nhận                       |
| `province`   | `VARCHAR(100)` | NOT NULL                        | Tỉnh/Thành phố                       |
| `district`   | `VARCHAR(100)` | NOT NULL                        | Quận/Huyện                           |
| `ward`       | `VARCHAR(100)` | NOT NULL                        | Phường/Xã                            |
| `street`     | `TEXT`         | NOT NULL                        | Địa chỉ chi tiết (số nhà, tên đường) |
| `is_default` | `BOOLEAN`      | NOT NULL DEFAULT false          | Địa chỉ mặc định                     |
| `created_at` | `TIMESTAMPTZ`  | NOT NULL DEFAULT NOW()          |                                      |

```sql
-- Chỉ 1 địa chỉ mặc định per user (partial unique index)
CREATE UNIQUE INDEX idx_user_default_address
  ON user_addresses(user_id)
  WHERE is_default = true;
```

**Giới hạn nghiệp vụ:** Mỗi user tối đa **5 địa chỉ**.

---

### 2.3 Entity: `refresh_tokens` (Audit)

| Column       | Type          | Constraint                      | Mô tả             |
| ------------ | ------------- | ------------------------------- | ----------------- |
| `id`         | `UUID`        | PK                              |                   |
| `user_id`    | `UUID`        | FK → users.id ON DELETE CASCADE |                   |
| `token_hash` | `VARCHAR(64)` | NOT NULL                        | SHA-256(rawToken) |
| `issued_at`  | `TIMESTAMPTZ` | NOT NULL                        |                   |
| `expires_at` | `TIMESTAMPTZ` | NOT NULL                        |                   |
| `revoked_at` | `TIMESTAMPTZ` | NULLABLE                        | null = còn hợp lệ |
| `ip_address` | `INET`        | NULLABLE                        | IP client         |
| `user_agent` | `TEXT`        | NULLABLE                        | Browser/App info  |

> Lưu **hash** không lưu raw token — tránh rò rỉ nếu DB bị dump.

---

## 3. Business Rules

### BR-AUTH-001: Đăng ký tài khoản

- Email normalize về lowercase trước khi lưu và kiểm tra unique (case-insensitive)
- Password **không** lưu trong DB local — chỉ gửi sang Keycloak
- Quy trình: tạo user Keycloak trước → lấy `keycloakId` → INSERT users
- Nếu INSERT users thất bại sau khi Keycloak đã tạo: **compensate** (delete Keycloak user)
- Role mặc định là `USER`
- Sau đăng ký: publish Kafka event `user.registered` (cho Notification Service gửi email)

### BR-AUTH-002: Đăng nhập

- Xác thực qua **Keycloak Resource Owner Password Credentials** grant
- Không tự verify password trong service
- Sau login thành công: UPDATE `last_login_at = NOW()`
- Keycloak tự lock sau **5 lần sai** trong **15 phút** (cấu hình tại Realm settings)
- `access_token` TTL = **15 phút** | `refresh_token` TTL = **7 ngày**

### BR-AUTH-003: Refresh Token

- Single-use token: dùng 1 lần thì revoke token cũ, cấp token mới
- Nếu một refresh token đã bị revoke nhưng được dùng lại → **Token Theft Detection** → revoke **toàn bộ** phiên của user
- Refresh token hết hạn → buộc đăng nhập lại (không tự gia hạn)

### BR-AUTH-004: Role & Phân quyền

- `USER`: xem/sửa thông tin bản thân, mua hàng
- `ADMIN`: quản lý sản phẩm + danh mục + đơn hàng + user
- Chỉ `ADMIN` mới nâng/hạ role của user khác
- **Không cho phép** `ADMIN` thay đổi role của chính mình (self-demotion/self-promotion)
- Khi đổi role: đồng bộ realm role sang Keycloak

### BR-AUTH-005: Địa chỉ giao hàng

- Tối đa **5 địa chỉ** / user — vượt quá → 422
- Set `is_default = true`: tự động unset `is_default` ở tất cả địa chỉ khác của user
- Xóa địa chỉ đang là mặc định: địa chỉ mới nhất (sort `created_at DESC`) tự động thành mặc định
- Không xóa địa chỉ đang được reference trong đơn hàng `PENDING` hoặc `CONFIRMED`

### BR-AUTH-006: Cập nhật profile

- `email` là **immutable** sau khi đăng ký — không cho phép sửa
- Sửa `name`, `phone`, `avatar_url`: chỉ update DB local (không cần sync Keycloak)
- ADMIN sửa role user khác: cần sync sang Keycloak realm roles

---

## 4. API Contract

### `POST /api/auth/register`

**Request:**

```json
{
  "email": "nguyen.van.a@example.com",
  "password": "Secure@2026",
  "name": "Nguyễn Văn A",
  "phone": "0901234567"
}
```

| Field      | Required | Rule                                       |
| ---------- | -------- | ------------------------------------------ |
| `email`    | ✅       | RFC 5322, max 255 chars                    |
| `password` | ✅       | Xem [Password Policy](#7-validation-rules) |
| `name`     | ✅       | 2–100 chars                                |
| `phone`    | ❌       | `0[3-9][0-9]{8}`                           |

**Response 201:**

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "nguyen.van.a@example.com",
    "name": "Nguyễn Văn A",
    "role": "USER",
    "status": "ACTIVE",
    "createdAt": "2026-04-22T09:00:00.000Z"
  }
}
```

**Errors:** `400` validation | `409` email đã tồn tại

---

### `POST /api/auth/login`

**Request:**

```json
{ "email": "nguyen.van.a@example.com", "password": "Secure@2026" }
```

**Response 200:**

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 900,
    "tokenType": "Bearer",
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "nguyen.van.a@example.com",
      "name": "Nguyễn Văn A",
      "role": "USER"
    }
  }
}
```

**Errors:** `401` sai credentials | `401` account banned/inactive

---

### `POST /api/auth/refresh`

**Request:**

```json
{ "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }
```

**Response 200:**

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 900
  }
}
```

**Errors:** `401` token hết hạn | `401` token đã bị revoke

---

### `POST /api/auth/logout`

**Headers:** `Authorization: Bearer <accessToken>`

**Request:**

```json
{ "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }
```

**Response 200:**

```json
{ "success": true, "message": "Logged out successfully" }
```

---

### `GET /api/auth/me`

**Headers:** `Authorization: Bearer <accessToken>`

**Response 200:**

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "nguyen.van.a@example.com",
    "name": "Nguyễn Văn A",
    "phone": "0901234567",
    "role": "USER",
    "status": "ACTIVE",
    "avatarUrl": null,
    "lastLoginAt": "2026-04-22T08:55:00.000Z",
    "createdAt": "2026-04-22T09:00:00.000Z"
  }
}
```

---

### `PATCH /api/auth/me`

**Headers:** `Authorization: Bearer <accessToken>`

**Request (all optional):**

```json
{
  "name": "Nguyễn Văn B",
  "phone": "0909999999",
  "avatarUrl": "https://res.cloudinary.com/ecommerce/image/upload/sample.jpg"
}
```

**Response 200:** user object đã cập nhật

**Errors:** `400` validation

---

### `GET /api/auth/addresses`

**Headers:** `Authorization: Bearer <accessToken>`

**Response 200:**

```json
{
  "success": true,
  "data": [
    {
      "id": "addr-uuid-1",
      "label": "Nhà",
      "fullName": "Nguyễn Văn A",
      "phone": "0901234567",
      "province": "TP. Hồ Chí Minh",
      "district": "Quận 1",
      "ward": "Phường Bến Nghé",
      "street": "123 Đường Lê Lợi",
      "isDefault": true
    }
  ]
}
```

---

### `POST /api/auth/addresses`

**Headers:** `Authorization: Bearer <accessToken>`

**Request:**

```json
{
  "label": "Văn phòng",
  "fullName": "Nguyễn Văn A",
  "phone": "0901234567",
  "province": "TP. Hồ Chí Minh",
  "district": "Quận 3",
  "ward": "Phường 9",
  "street": "45 Đường Võ Văn Tần",
  "isDefault": false
}
```

**Response 201:** address object mới tạo

**Errors:** `400` validation | `422` đã có 5 địa chỉ

---

### `PATCH /api/auth/addresses/:id`

**Headers:** `Authorization: Bearer <accessToken>`

**Request:** các field muốn sửa (cùng structure với POST)

**Errors:** `403` địa chỉ không thuộc user | `404` không tìm thấy

---

### `PUT /api/auth/addresses/:id/default`

**Headers:** `Authorization: Bearer <accessToken>`

**Response 200:**

```json
{ "success": true, "message": "Default address updated" }
```

---

### `DELETE /api/auth/addresses/:id`

**Headers:** `Authorization: Bearer <accessToken>`

**Response 200:**

```json
{ "success": true }
```

**Errors:** `403` địa chỉ không thuộc user | `409` địa chỉ đang dùng trong đơn PENDING/CONFIRMED

---

### `GET /api/users` _(ADMIN only)_

**Query Params:**

```
?page=1&limit=20&search=nguyen&role=USER&status=ACTIVE&sort=createdAt&order=desc
```

**Response 200:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "email": "...",
      "name": "...",
      "role": "USER",
      "status": "ACTIVE",
      "lastLoginAt": "...",
      "createdAt": "..."
    }
  ],
  "meta": { "total": 150, "page": 1, "limit": 20, "totalPages": 8 }
}
```

---

### `GET /api/users/:id` _(ADMIN only)_

**Response 200:** full user object bao gồm `addresses[]`

**Errors:** `404` user không tồn tại

---

### `PATCH /api/users/:id/role` _(ADMIN only)_

**Request:**

```json
{ "role": "ADMIN" }
```

**Errors:** `403` tự thay đổi role mình | `404` user không tồn tại

---

### `PATCH /api/users/:id/status` _(ADMIN only)_

**Request:**

```json
{ "status": "BANNED", "reason": "Vi phạm điều khoản sử dụng" }
```

**Errors:** `400` invalid status value | `403` tự ban mình

---

## 5. State Machine — User Account

```
           [Đăng ký]
               │
               ▼
          ┌─────────┐
          │  ACTIVE │◀──────────────────────────┐
          └─────────┘                           │
         /            \                         │
[ADMIN deactivate]   [ADMIN ban]    [ADMIN reactivate / unban]
        │                 │                     │
        ▼                 ▼                     │
  ┌──────────┐      ┌────────┐                  │
  │ INACTIVE │      │ BANNED │──────────────────┘
  └──────────┘      └────────┘
```

**Quy tắc state:**

| Transition          | Ai làm được      | Ghi chú                             |
| ------------------- | ---------------- | ----------------------------------- |
| `ACTIVE → INACTIVE` | ADMIN            | Disable tạm thời, không bị xóa data |
| `ACTIVE → BANNED`   | ADMIN            | Vi phạm; phải kèm `reason`          |
| `INACTIVE → ACTIVE` | ADMIN            | Kích hoạt lại                       |
| `BANNED → ACTIVE`   | ADMIN            | Gỡ ban                              |
| `BANNED → INACTIVE` | ADMIN            | Downgrade ban thành inactive        |
| Xóa vĩnh viễn       | **Không hỗ trợ** | Giữ audit trail                     |

Khi status ≠ `ACTIVE`: đồng thời **disable user trong Keycloak** (prevent login tại source).

---

## 6. Luồng Nghiệp Vụ

### 6.1 Đăng Ký

```
Client          Auth Service            Keycloak          DB (RDS)
  │                  │                      │                 │
  ├─POST /register──▶│                      │                 │
  │                  ├─validate input       │                 │
  │                  ├─check email unique──────────────────── ▶│
  │                  │◀──── (unique OK) ─────────────────────│
  │                  │                      │                 │
  │                  ├─create user in KC───▶│                 │
  │                  │◀── keycloakId ───────│                 │
  │                  │                      │                 │
  │                  ├─INSERT users ─────────────────────────▶│
  │                  │◀── user record ───────────────────────│
  │                  │                      │                 │
  │◀── 201 {user} ───│                      │                 │
  │                  │                      │                 │
  │                  ├─Kafka: user.registered ──▶ Notification Service
```

### 6.2 Đăng Nhập

```
Client          Auth Service            Keycloak          DB (RDS)
  │                  │                      │                 │
  ├─POST /login ────▶│                      │                 │
  │                  ├─POST /token (KC) ───▶│                 │
  │                  │◀── {access, refresh}─│                 │
  │                  ├─UPDATE last_login ────────────────────▶│
  │◀── 200 {tokens} ─│
```

### 6.3 JWT Verify tại API Gateway

```
Mọi protected request
        │
        ▼
   Gateway JwtGuard
        │
        ├── 1. Parse "Bearer <token>"
        ├── 2. Get JWKS from Keycloak (cache TTL 1h)
        ├── 3. Verify RS256 signature
        ├── 4. Check exp (expiry)
        ├── 5. Check iss == "http://keycloak:8080/realms/ecommerce"
        │
        ├── [VALID]   → inject { userId, role, email } vào request
        └── [INVALID] → 401 Unauthorized (không forward tới service)
```

---

## 7. Validation Rules

### Password Policy

| Rule                   | Giá trị                                          |
| ---------------------- | ------------------------------------------------ |
| Độ dài tối thiểu       | 8 ký tự                                          |
| Độ dài tối đa          | 72 ký tự (giới hạn bcrypt của Keycloak)          |
| Phải có chữ hoa        | ≥ 1 ký tự `[A-Z]`                                |
| Phải có chữ thường     | ≥ 1 ký tự `[a-z]`                                |
| Phải có số             | ≥ 1 ký tự `[0-9]`                                |
| Phải có ký tự đặc biệt | ≥ 1 trong `@$!%*?&`                              |
| Không được trùng email | `password.toLowerCase() !== email.toLowerCase()` |

### Email Rules

- Format RFC 5322, max 255 chars
- Normalize lowercase + trim whitespace trước khi lưu
- Immutable sau khi tạo

### Phone Rules

- Regex: `^0[3-9][0-9]{8}$`
- Loại bỏ khoảng trắng và dấu `-` trước validate
- Optional field

### Name Rules

- Độ dài: 2–100 ký tự
- Chấp nhận: chữ cái (bao gồm Unicode tiếng Việt), số, khoảng trắng
- Không chấp nhận: `< > " ; -- DROP` (basic XSS/SQLi protection)

---

## 8. Error Catalog

| HTTP | Error Code               | Message (vi)                              | Điều kiện                     |
| ---- | ------------------------ | ----------------------------------------- | ----------------------------- |
| 400  | `VALIDATION_ERROR`       | "Dữ liệu không hợp lệ"                    | Input sai format/constraint   |
| 400  | `WEAK_PASSWORD`          | "Mật khẩu không đủ mạnh"                  | Không đáp ứng password policy |
| 401  | `INVALID_CREDENTIALS`    | "Email hoặc mật khẩu không đúng"          | Login sai                     |
| 401  | `TOKEN_EXPIRED`          | "Phiên đăng nhập đã hết hạn"              | Access token hết hạn          |
| 401  | `INVALID_TOKEN`          | "Token không hợp lệ"                      | JWT sai chữ ký                |
| 401  | `TOKEN_REVOKED`          | "Token đã bị thu hồi"                     | Refresh token revoked         |
| 401  | `ACCOUNT_BANNED`         | "Tài khoản đã bị khóa"                    | status = BANNED               |
| 401  | `ACCOUNT_INACTIVE`       | "Tài khoản chưa được kích hoạt"           | status = INACTIVE             |
| 403  | `FORBIDDEN`              | "Không có quyền thực hiện thao tác này"   | Role không đủ                 |
| 403  | `SELF_ROLE_CHANGE`       | "Không thể thay đổi role của chính mình"  | Admin tự đổi role             |
| 404  | `USER_NOT_FOUND`         | "Không tìm thấy người dùng"               | User ID không tồn tại         |
| 409  | `EMAIL_ALREADY_EXISTS`   | "Email đã được sử dụng"                   | Register trùng email          |
| 422  | `ADDRESS_LIMIT_EXCEEDED` | "Tối đa 5 địa chỉ mỗi tài khoản"          | Vượt quá 5 địa chỉ            |
| 422  | `ADDRESS_IN_USE`         | "Địa chỉ đang được dùng trong đơn hàng"   | Xóa addr của đơn PENDING      |
| 500  | `KEYCLOAK_SYNC_FAILED`   | "Lỗi hệ thống xác thực, vui lòng thử lại" | Keycloak không phản hồi       |

---

## 9. Security Requirements

| ID           | Rule                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------- |
| SEC-AUTH-001 | Frontend KHÔNG lưu token trong `localStorage` — dùng `httpOnly cookie`                   |
| SEC-AUTH-002 | Rate limit `POST /login`: 10 req/phút/IP                                                 |
| SEC-AUTH-003 | Rate limit `POST /register`: 5 req/phút/IP                                               |
| SEC-AUTH-004 | Rate limit `POST /refresh`: 20 req/phút/IP                                               |
| SEC-AUTH-005 | DB local KHÔNG BAO GIỜ lưu raw password hoặc hash                                        |
| SEC-AUTH-006 | Keycloak JWKS public key được cache TTL 1h; force-refresh khi key rotate                 |
| SEC-AUTH-007 | Mọi action login/logout/ban/role-change được ghi vào `refresh_tokens` audit log          |
| SEC-AUTH-008 | `refreshToken` chỉ gửi qua request body/header, KHÔNG qua URL query string               |
| SEC-AUTH-009 | Token Theft Detection: refresh token đã revoke mà dùng lại → revoke toàn bộ session user |

---

## 10. Quên & Đặt Lại Mật Khẩu

### Luồng Nghiệp Vụ

```
User         Auth Service         Keycloak         Notification Svc      DB
  │               │                    │                   │              │
  ├─POST /forgot-password ─────────────▶│                   │              │
  │  { email }    │                    │                    │              │
  │               ├─ Lookup user by email ─────────────────────────────── ▶│
  │               │  (nếu không tồn tại: vẫn 200, không tiết lộ)          │
  │               │                    │                   │              │
  │               ├─ Tạo reset_token = JWT RS256            │              │
  │               │  { sub: userId, type: "password_reset", exp: 15min }  │
  │               ├─ Kafka: user.password.reset.requested ─▶│              │
  │               │          { email, token, expiry }       │              │
  │◀── 200 ───────│                    │            Email gửi link:        │
  │               │                    │     /reset-password?token=xxx     │
  │               │                    │                   │              │
  ├─POST /reset-password               │                   │              │
  │  { token, newPassword } ──────────▶│                   │              │
  │               ├─ Verify JWT token  │                   │              │
  │               ├─ Check not expired │                   │              │
  │               ├─ Check not already used (token_used_at IS NULL) ─────▶│
  │               ├─ Update KC password:                   │              │
  │               │   keycloak.users.resetPassword(kcId)   │              │
  │               │◀── OK ────────────│                   │              │
  │               ├─ Mark token used ─────────────────────────────────── ▶│
  │               ├─ Revoke all refresh tokens of user ─────────────────▶│
  │◀── 200 ───────│                    │                   │              │
```

### Entities bổ sung: `password_reset_tokens`

| Column       | Type          | Constraint             | Mô tả             |
| ------------ | ------------- | ---------------------- | ----------------- |
| `id`         | `UUID`        | PK                     |                   |
| `user_id`    | `UUID`        | FK → users.id          |                   |
| `token_hash` | `VARCHAR(64)` | NOT NULL               | SHA-256(rawToken) |
| `expires_at` | `TIMESTAMPTZ` | NOT NULL               | NOW() + 15 phút   |
| `used_at`    | `TIMESTAMPTZ` | NULLABLE               | Null = chưa dùng  |
| `ip_address` | `INET`        | NULLABLE               | IP request        |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT NOW() |                   |

```sql
CREATE INDEX idx_pwd_reset_user ON password_reset_tokens(user_id);
CREATE INDEX idx_pwd_reset_token ON password_reset_tokens(token_hash);
```

### Business Rules

- Mỗi lần gọi `/forgot-password` tạo token mới, invalidate token cũ (set `used_at = NOW()`)
- Token expire sau **15 phút**
- Rate limit: tối đa **3 request** `/forgot-password` mỗi 60 phút per IP / per email
- Dùng constant-time compare khi verify token hash (tránh timing attack)
- Sau reset: **revoke toàn bộ refresh tokens** của user (force re-login trên tất cả thiết bị)

### API Endpoints

**`POST /api/auth/forgot-password`** _(Public)_

```json
// Request
{ "email": "nguyen.van.a@example.com" }

// Response 200 (luôn 200, không tiết lộ user tồn tại hay không)
{ "success": true, "message": "Nếu email tồn tại, chúng tôi đã gửi hướng dẫn đặt lại mật khẩu" }
```

**`POST /api/auth/reset-password`** _(Public)_

```json
// Request
{
  "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "newPassword": "NewSecure@2026"
}

// Response 200
{ "success": true, "message": "Mật khẩu đã được cập nhật thành công. Vui lòng đăng nhập lại." }
```

| HTTP | Error Code            | Message                                           |
| ---- | --------------------- | ------------------------------------------------- |
| 400  | `RESET_TOKEN_INVALID` | "Liên kết đặt lại mật khẩu không hợp lệ"          |
| 400  | `RESET_TOKEN_EXPIRED` | "Liên kết đặt lại mật khẩu đã hết hạn (15 phút)"  |
| 400  | `RESET_TOKEN_USED`    | "Liên kết này đã được sử dụng"                    |
| 400  | `WEAK_PASSWORD`       | "Mật khẩu không đủ mạnh"                          |
| 429  | `RESET_RATE_LIMIT`    | "Quá nhiều yêu cầu. Vui lòng thử lại sau 60 phút" |

---

## 11. Xác Thực Email

### Mục đích

Đảm bảo email user cung cấp là hợp lệ và họ sở hữu inbox đó.

### Entity bổ sung: `email_verification_tokens`

| Column        | Type          | Constraint             | Mô tả             |
| ------------- | ------------- | ---------------------- | ----------------- |
| `id`          | `UUID`        | PK                     |                   |
| `user_id`     | `UUID`        | FK → users.id          |                   |
| `token_hash`  | `VARCHAR(64)` | NOT NULL               | SHA-256(rawToken) |
| `expires_at`  | `TIMESTAMPTZ` | NOT NULL               | NOW() + 24 giờ    |
| `verified_at` | `TIMESTAMPTZ` | NULLABLE               |                   |
| `created_at`  | `TIMESTAMPTZ` | NOT NULL DEFAULT NOW() |                   |

### Cập nhật `users` table

| Column thêm         | Type          | Default  | Mô tả                |
| ------------------- | ------------- | -------- | -------------------- |
| `email_verified_at` | `TIMESTAMPTZ` | NULLABLE | Null = chưa xác thực |

### Luồng

```
1. Sau đăng ký: publish Kafka user.email.verify.requested
   → notification-service gửi email link: /api/auth/verify-email?token=xxx
2. User click link:
   GET /api/auth/verify-email?token=xxx
   → verify JWT token, check expiry
   → UPDATE users SET email_verified_at = NOW()
   → UPDATE email_verification_tokens SET verified_at = NOW()
   → Redirect frontend: /login?verified=true
3. Nếu token hết hạn:
   POST /api/auth/resend-verification
   → Tạo token mới, gửi email lại
```

### Business Rules

- Token expire sau **24 giờ**
- User có thể login ngay cả khi chưa verify email (tùy config — MVP: không bắt buộc verify)
- Tối đa **3 lần** resend verification per 24 giờ
- Token dùng 1 lần: sau verify set `verified_at`, không dùng được nữa

### API Endpoints

**`GET /api/auth/verify-email`** _(Public)_

```
Query: ?token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...

Response 302 Redirect: /login?verified=true
Response 400 { error: "VERIFY_TOKEN_EXPIRED" }
```

**`POST /api/auth/resend-verification`** _(User — requires JWT)_

```json
// Response 200
{ "success": true, "message": "Email xác thực đã được gửi lại" }
```

| HTTP | Error Code         | Message                                 |
| ---- | ------------------ | --------------------------------------- |
| 400  | `ALREADY_VERIFIED` | "Email đã được xác thực trước đó"       |
| 429  | `RESEND_LIMIT`     | "Đã gửi quá 3 lần. Vui lòng chờ 24 giờ" |

---

## 12. Social Login — Google (via Keycloak IDP)

### Kiến trúc

Google OAuth2 được cấu hình tại **Keycloak** như 1 Identity Provider (IDP). Frontend redirect sang Keycloak, Keycloak xử lý Google OIDC, sau đó trả JWT về hệ thống.

```
Frontend              Auth Service          Keycloak           Google OAuth
   │                       │                    │                    │
   ├─ GET /api/auth/social/google ──────────────▶│                    │
   │                       ├─ Tạo authorization URL                   │
   │◀── 302 redirect ───────│                    │                    │
   │   URL: KC /auth?idp=google                  │                    │
   │                                             │                    │
   ├── (Browser redirect đến Keycloak) ──────────▶│                    │
   │                                             ├─ redirect to Google▶│
   │                                             │◀── auth code ──────│
   │                                             ├─ exchange for token │
   │                                             ├─ create/link KC user│
   │◀─ (redirect to frontend callback) ──────────│                    │
   │   /auth/callback?code=xxx&state=yyy          │                    │
   │                                             │                    │
   ├─ POST /api/auth/social/callback ─────────────▶│                    │
   │   { code, state }    │                      │                    │
   │                       ├─ exchange code with KC                    │
   │                       │  → access_token, refresh_token            │
   │                       ├─ lookup user bằng keycloak_id             │
   │                       │  nếu mới: INSERT user (name từ Google)    │
   │◀── 200 { tokens } ───│                      │                    │
```

### Provisioning User mới từ Google

```
Khi user lần đầu login bằng Google:
1. Keycloak tạo user trong realm với email từ Google
2. auth-service nhận callback, lookup user bằng keycloak_id
3. Nếu chưa có trong DB: INSERT user {
     email: google_email,
     name: google_name,
     keycloak_id: kc_user_id,
     role: USER,
     status: ACTIVE,
     email_verified_at: NOW()  ← Google đã verify email
   }
4. Publish Kafka: user.registered (nếu user mới)
```

### Business Rules

- Social login không có password trong hệ thống
- User đăng ký bằng email thông thường + sau đó dùng Google (cùng email) → **link account** (cùng `keycloak_id`)
- Google user không thể dùng `POST /auth/forgot-password` (không có password)
- `email` là immutable kể cả social login

### API Endpoints

**`GET /api/auth/social/google`** _(Public)_

```
Response 302: Redirect đến Keycloak authorization URL
```

**`POST /api/auth/social/callback`** _(Public)_

```json
// Request
{ "code": "auth-code-from-keycloak", "state": "csrf-state-token" }

// Response 200
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "...",
    "isNewUser": true,
    "user": { "id": "...", "email": "...", "name": "..." }
  }
}
```

| HTTP | Error Code           | Message                                       |
| ---- | -------------------- | --------------------------------------------- |
| 400  | `SOCIAL_AUTH_FAILED` | "Đăng nhập Google thất bại, vui lòng thử lại" |
| 400  | `STATE_MISMATCH`     | "Lỗi bảo mật, vui lòng thử lại"               |

---

## 13. Xóa Tài Khoản (GDPR Compliance)

### Nguyên tắc

GDPR yêu cầu quyền "Được quên" (Right to be Forgotten). Tuy nhiên, **không xóa hard** dữ liệu đơn hàng vì:

1. Nghĩa vụ kế toán / kiểm toán
2. Bảo vệ merchant khỏi dispute
3. Cascade delete sẽ gây mất dữ liệu inventory history

**Giải pháp: Anonymize thay vì xóa.**

### Quy trình Anonymize

```
User yêu cầu DELETE /api/auth/account:

1. Check không có order PENDING/PROCESSING/SHIPPING:
   → Nếu có: 409 "Không thể xóa tài khoản khi có đơn hàng đang xử lý"

2. Anonymize bảng users:
   UPDATE users SET
     email = 'deleted_' || id::text || '@deleted.local',
     name = 'Người dùng đã xóa',
     phone = NULL,
     avatar_url = NULL,
     status = 'DELETED',   ← thêm trạng thái mới
     deleted_at = NOW()
   WHERE id = :userId;

3. Xóa trong Keycloak:
   keycloak.users.delete(keycloakId)

4. Xóa địa chỉ:
   DELETE FROM user_addresses WHERE user_id = :userId;

5. Revoke tất cả refresh tokens:
   UPDATE refresh_tokens SET revoked_at = NOW()
   WHERE user_id = :userId;

6. Xóa wishlist (MongoDB):
   db.wishlists.deleteOne({ userId: userId });

7. Orders lịch sử:
   Giữ nguyên orders với user_id (để audit)
   order.user_name đã snapshot → không cần sửa

8. Reviews: Set user_id = system_anonymized_user_id (hoặc giữ với tên "Đã xóa")
```

### Thêm vào schema users

| Column thêm  | Type          | Mô tả                        |
| ------------ | ------------- | ---------------------------- |
| `deleted_at` | `TIMESTAMPTZ` | Nullable — timestamp khi xóa |

**Thêm `DELETED` vào ENUM:**

```sql
ALTER TYPE user_status ADD VALUE 'DELETED';
```

### API Endpoint

**`DELETE /api/auth/account`** _(User — requires JWT)_

**Request:** _(optional confirmation)_

```json
{ "confirmation": "XÁC NHẬN XÓA TÀI KHOẢN" }
```

**Response 200:**

```json
{
  "success": true,
  "message": "Tài khoản của bạn đã được xóa thành công. Dữ liệu lịch sử mua hàng được giữ lại theo quy định."
}
```

| HTTP | Error Code              | Message                                              |
| ---- | ----------------------- | ---------------------------------------------------- |
| 400  | `CONFIRMATION_REQUIRED` | "Vui lòng xác nhận xóa tài khoản"                    |
| 409  | `ACTIVE_ORDERS_EXIST`   | "Không thể xóa tài khoản khi có đơn hàng đang xử lý" |
