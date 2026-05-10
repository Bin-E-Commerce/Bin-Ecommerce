# Hướng dẫn Setup Keycloak & OAuth Social Login

## Mục lục
1. [Cài đặt Keycloak bằng Docker](#1-cài-đặt-keycloak-bằng-docker)
2. [Tạo Realm](#2-tạo-realm)
3. [Tạo Client (OIDC)](#3-tạo-client-oidc)
4. [Tạo Roles](#4-tạo-roles)
5. [Cấu hình Social Login — Google](#5-cấu-hình-social-login--google)
6. [Cấu hình Social Login — Facebook](#6-cấu-hình-social-login--facebook)
7. [Lấy Client Secret](#7-lấy-client-secret)
8. [Biến môi trường cần cấu hình](#8-biến-môi-trường-cần-cấu-hình)
9. [Kiểm tra hoạt động](#9-kiểm-tra-hoạt-động)

---

## 1. Cài đặt Keycloak bằng Docker

```bash
docker run -d \
  --name keycloak \
  -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:25.0 \
  start-dev
```

Truy cập **http://localhost:8080** → đăng nhập bằng `admin / admin`.

> **Production**: Dùng `start` thay vì `start-dev`, cấu hình TLS, và thay đổi mật khẩu admin.

---

## 2. Tạo Realm

1. Vào menu bên trái → **Create realm**
2. **Realm name**: `bin-ecommerce` (phải khớp với `KEYCLOAK_REALM` trong `.env`)
3. Nhấn **Create**

---

## 3. Tạo Client (OIDC)

1. Vào **Clients** → **Create client**
2. **Client ID**: `bin-ecommerce-client` (phải khớp với `KEYCLOAK_CLIENT_ID`)
3. **Client type**: `OpenID Connect`
4. Nhấn **Next** → bật **Client authentication** (ON) → **Next**
5. **Valid redirect URIs**:
   - `http://localhost:3000/*`
   - `http://localhost:5173/*`
   - `https://yourdomain.com/*` *(production)*
6. **Valid post logout redirect URIs**: `http://localhost:5173/*`
7. **Web origins**: `+` (cho phép CORS dựa trên redirect URIs)
8. Nhấn **Save**

---

## 4. Tạo Roles

Vào **Realm roles** → **Create role** cho từng role sau:

| Role name  | Mô tả                            |
|------------|----------------------------------|
| `customer` | Khách hàng mặc định              |
| `admin`    | Quản trị viên có toàn quyền      |
| `staff`    | Nhân viên có quyền hạn giới hạn  |

---

## 5. Cấu hình Social Login — Google

### Bước 1: Tạo Google OAuth App

1. Vào [Google Cloud Console](https://console.cloud.google.com/)
2. **Chọn hoặc tạo Project** → tìm kiếm project hoặc nhấn **New Project**
3. Vào **APIs & Services** → **OAuth consent screen**
   - User Type: **External**
   - App name: `Bin E-Commerce`
   - User support email: email của bạn
   - Developer contact: email của bạn
   - Nhấn **Save and Continue** qua các bước (không cần thêm scopes hay test users lúc này)
4. Vào **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth 2.0 Client IDs**
   - Application type: **Web application**
   - Name: `Bin E-Commerce Keycloak`
   - **Authorized JavaScript origins**:
     - `http://localhost:8080`
   - **Authorized redirect URIs**:
     - `http://localhost:8080/realms/bin-ecommerce/broker/google/endpoint`
     - *(production)* `https://keycloak.yourdomain.com/realms/bin-ecommerce/broker/google/endpoint`
5. Nhấn **Create** → lưu lại **Client ID** và **Client Secret**

### Bước 2: Thêm Google vào Keycloak

1. Trong Keycloak, vào realm `bin-ecommerce` → **Identity Providers** → **Add provider** → **Google**
2. Điền:
   - **Client ID**: Client ID từ Google Cloud
   - **Client Secret**: Client Secret từ Google Cloud
3. **Sync mode**: `force` (đồng bộ thông tin mỗi lần đăng nhập)
4. **Trust Email**: bật ON (Google đã xác thực email)
5. Nhấn **Save**

---

## 6. Cấu hình Social Login — Facebook

### Bước 1: Tạo Facebook App

1. Vào [Meta for Developers](https://developers.facebook.com/)
2. Nhấn **My Apps** → **Create App**
3. **Use case**: `Authenticate and request data from users` → **Next**
4. **App name**: `Bin E-Commerce`, điền email liên hệ → **Create app**
5. Sau khi tạo xong, vào **App settings** → **Basic**:
   - Lưu lại **App ID** và **App Secret** (nhấn **Show**)
   - **App Domains**: `localhost` (thêm domain production sau)
   - **Privacy Policy URL**: bắt buộc nếu muốn publish app (có thể dùng URL placeholder khi dev)
6. Vào **Add a product** → tìm **Facebook Login** → **Set up** → chọn **Web**
7. Vào **Facebook Login** → **Settings**:
   - **Valid OAuth Redirect URIs**:
     - `http://localhost:8080/realms/bin-ecommerce/broker/facebook/endpoint`
     - *(production)* `https://keycloak.yourdomain.com/realms/bin-ecommerce/broker/facebook/endpoint`
   - Bật **Login with the JavaScript SDK**: OFF
   - Nhấn **Save Changes**

### Bước 2: Thêm Facebook vào Keycloak

1. Trong Keycloak → **Identity Providers** → **Add provider** → **Facebook**
2. Điền:
   - **Client ID**: App ID từ Facebook
   - **Client Secret**: App Secret từ Facebook
3. **Default scopes**: `email,public_profile`
4. **Trust Email**: OFF (Facebook email chưa chắc đã xác thực)
5. Nhấn **Save**

> **Lưu ý**: Facebook yêu cầu app phải ở chế độ **Live** (không phải Development) để người dùng bên ngoài có thể đăng nhập. Trong quá trình dev, chỉ Test Users mới có thể login.

---

## 7. Lấy Client Secret

1. Trong Keycloak, vào **Clients** → chọn `bin-ecommerce-client`
2. Tab **Credentials**
3. Nhấn **Regenerate** để tạo secret mới
4. Copy **Client Secret** → dùng cho biến `KEYCLOAK_CLIENT_SECRET`

---

## 8. Biến môi trường cần cấu hình

Tạo file `.env` trong thư mục `services/auth-service/`:

```env
# ── Keycloak ──────────────────────────────────────────────────────────
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=bin-ecommerce
KEYCLOAK_CLIENT_ID=bin-ecommerce-client
KEYCLOAK_CLIENT_SECRET=<client-secret-từ-bước-7>

# Tài khoản admin Keycloak (dùng để gọi Admin REST API)
KEYCLOAK_ADMIN_USERNAME=admin
KEYCLOAK_ADMIN_PASSWORD=admin

# ── Application ───────────────────────────────────────────────────────
FRONTEND_URL=http://localhost:5173
NODE_ENV=development

# ── Database (PostgreSQL) ─────────────────────────────────────────────
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_NAME=auth_db

# ── Redis (OTP storage) ───────────────────────────────────────────────
REDIS_HOST=localhost
REDIS_PORT=6379

# ── Kafka ─────────────────────────────────────────────────────────────
KAFKA_BROKERS=localhost:9092
```

---

## 9. Kiểm tra hoạt động

### Kiểm tra Keycloak Admin API

```bash
# Lấy admin token
curl -X POST "http://localhost:8080/realms/master/protocol/openid-connect/token" \
  -d "client_id=admin-cli&username=admin&password=admin&grant_type=password"
```

### Kiểm tra social login

1. Chạy `auth-service` và `api-gateway`
2. Gọi: `GET http://localhost:3000/api/v1/auth/social/start/google`
3. Mở `authUrl` trong trình duyệt → đăng nhập bằng Google
4. Sau khi redirect về `/auth/callback?code=...&state=...`, frontend gọi:
   `POST http://localhost:3000/api/v1/auth/social/callback/google` với `{ code, state }`

### Kiểm tra forgot/reset password

```bash
# 1. Gửi OTP
curl -X POST "http://localhost:3000/api/v1/auth/forgot-password" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'

# 2. Đặt lại mật khẩu với OTP nhận được
curl -X POST "http://localhost:3000/api/v1/auth/reset-password" \
  -H "Content-Type: application/json" \
  -d '{"identifier":"user@example.com","otp":"123456","newPassword":"NewPass1"}'
```

---

## Troubleshooting

| Lỗi | Nguyên nhân | Giải pháp |
|-----|-------------|-----------|
| `invalid_redirect_uri` | Redirect URI không khớp | Kiểm tra Authorized redirect URIs trong Google/Facebook |
| `KEYCLOAK_ADMIN_PASSWORD wrong` | Sai credentials | Kiểm tra biến env |
| Facebook login chỉ hoạt động với test users | App ở chế độ Development | Chuyển sang Live mode hoặc thêm test users |
| `State mismatch` khi callback | In-memory state store đã mất | Restart auth-service, thử lại flow từ đầu |
| Google email không được trust | `Trust Email` = OFF | Bật `Trust Email` trong Identity Provider settings |
