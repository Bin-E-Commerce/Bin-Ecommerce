# Keycloak — Hướng dẫn hoạt động trong hệ thống Bin E-Commerce

---

## Mục lục

1. [Keycloak là gì?](#1-keycloak-là-gì)
2. [Kiến trúc trong hệ thống](#2-kiến-trúc-trong-hệ-thống)
3. [Realm và Clients](#3-realm-và-clients)
4. [Luồng xác thực (Auth Flows)](#4-luồng-xác-thực-auth-flows)
5. [JWT Token — cấu trúc và lifecycle](#5-jwt-token--cấu-trúc-và-lifecycle)
6. [JWKS — cách Gateway verify token](#6-jwks--cách-gateway-verify-token)
7. [Password Policy](#7-password-policy)
8. [Brute Force Protection](#8-brute-force-protection)
9. [Realm Import tự động](#9-realm-import-tự-động)
10. [Các API Keycloak sử dụng trong hệ thống](#10-các-api-keycloak-sử-dụng-trong-hệ-thống)
11. [Nginx Rate Limiting kết hợp Keycloak](#11-nginx-rate-limiting-kết-hợp-keycloak)
12. [Xử lý lỗi thường gặp](#12-xử-lý-lỗi-thường-gặp)

---

## 1. Keycloak là gì?

**Keycloak** là Identity and Access Management (IAM) server mã nguồn mở — nói đơn giản là hệ thống quản lý đăng nhập, đăng ký, token, roles cho toàn bộ ứng dụng.

**Thay vì** mỗi service tự implement logic đăng nhập, hash mật khẩu, quản lý session:

```
❌ Mỗi service tự làm:
  auth-service → bcrypt hash, JWT sign, refresh logic...

✅ Dùng Keycloak:
  auth-service → gọi Keycloak API → Keycloak trả về token
  Gateway → verify token bằng Keycloak public key (offline, không cần call Keycloak)
```

**Trong hệ thống này**, Keycloak chạy trong Docker (local dev) hoặc Keycloak Cloud (production), lắng nghe trên port **8080**.

---

## 2. Kiến trúc trong hệ thống

```
┌─────────────┐     ROPC Grant      ┌─────────────────────────────┐
│  Browser /  │ ─── POST /token ──▶ │         Keycloak            │
│  Next.js    │                     │  port 8080                  │
└─────────────┘                     │  Realm: bin-ecommerce       │
       │                            │                             │
       │ (1) Login request          │  ┌──────────────────────┐   │
       ▼                            │  │ Client: api-gateway  │   │
┌─────────────┐                     │  │ (confidential)       │   │
│ API Gateway │ ──── ROPC ────────▶ │  └──────────────────────┘   │
│  port 3000  │ ◀─── tokens ─────── │                             │
└─────────────┘                     │  ┌──────────────────────┐   │
       │                            │  │ Client: web-client   │   │
       │ verify JWT offline         │  │ (public, Auth Code)  │   │
       │ (JWKS cache 1h)            │  └──────────────────────┘   │
       ▼                            └─────────────────────────────┘
┌─────────────┐
│  Services   │  (auth-service, order-service, ...)
│  trust      │  chỉ đọc X-User-Id/Email/Roles
│  X-User-*   │  không cần gọi Keycloak
└─────────────┘
```

---

## 3. Realm và Clients

### Realm: `bin-ecommerce`

**Realm** là namespace độc lập trong Keycloak — tách biệt hoàn toàn user database, settings, clients.

Ví dụ: realm `bin-ecommerce` chỉ chứa users của ứng dụng này; không liên quan đến bất kỳ realm nào khác.

**Roles trong realm:**
```
USER   → default role, gán tự động khi đăng ký
ADMIN  → role đặc biệt, gán thủ công
```

---

### Client: `api-gateway` (confidential)

```json
{
  "clientId": "api-gateway",
  "directAccessGrantsEnabled": true,   ← ROPC grant
  "serviceAccountsEnabled": true,
  "secret": "<KEYCLOAK_CLIENT_SECRET>"
}
```

| Config | Giá trị | Ý nghĩa |
|--------|---------|---------|
| `directAccessGrantsEnabled` | `true` | Cho phép ROPC — đổi username/password → token |
| `serviceAccountsEnabled` | `true` | Client có thể lấy token cho chính nó (machine-to-machine) |
| `secret` | `changeme_keycloak_secret` | Client secret — **bắt buộc** cho confidential client |

**auth-service** dùng client này để gọi:
```
POST /realms/bin-ecommerce/protocol/openid-connect/token
  client_id=api-gateway
  client_secret=...
  grant_type=password
  username=user@example.com
  password=P@ssw0rd123
```

---

### Client: `web-client` (public)

```json
{
  "clientId": "web-client",
  "publicClient": true,
  "standardFlowEnabled": true,
  "redirectUris": ["http://localhost:5173/*", "https://*.vercel.app/*"]
}
```

Dùng **Authorization Code Flow** — flow an toàn cho browser (không có client secret). Hiện tại chưa implement (dùng ROPC qua api-gateway trước).

---

## 4. Luồng xác thực (Auth Flows)

### 4.1 ROPC — Resource Owner Password Credentials (flow chính)

Dùng khi user submit form login (username/password) qua API.

```
User                  Frontend              API Gateway           Keycloak
 │                       │                       │                    │
 │── POST /api/auth/login ─▶                     │                    │
 │   { email, password }  │                      │                    │
 │                        │── forward to ────────▶                   │
 │                        │   auth-service        │                    │
 │                        │                       │                    │
 │                        │                  POST /token               │
 │                        │                  grant_type=password ─────▶
 │                        │                  username, password        │
 │                        │                                       validate
 │                        │                                       password
 │                        │                  ◀── access_token ────────│
 │                        │                      refresh_token        │
 │                        │                      expires_in: 900      │
 │                        │◀─ { accessToken, user } ─────────────────│
 │◀── 200 OK ─────────────│                                           │
 │    Set-Cookie: refreshToken (HttpOnly)
```

**Access token TTL**: 900 giây (15 phút)  
**Refresh token TTL**: 604800 giây (7 ngày)

---

### 4.2 Token Refresh (silent refresh)

```
Frontend (axios interceptor)
  → API call → 401 Unauthorized
  → Gửi refreshToken (từ HttpOnly cookie)
    → POST /api/auth/refresh
      → auth-service gọi Keycloak:
          POST /token { grant_type=refresh_token, refresh_token=... }
      ← new access_token
  → Retry original request với access_token mới
```

**Lưu ý**: Trong frontend (`authorizedAxios.ts`), có **token refresh queue** — nếu nhiều request 401 cùng lúc, chỉ gọi `/refresh` **1 lần**, các request còn lại đợi rồi retry cùng lúc.

---

### 4.3 Token Theft Detection (410 Gone)

Nếu auth-service phát hiện refresh token đã bị dùng rồi (token reuse attack):

```
auth-service → trả về 410 Gone
Frontend → nhận 410 → xoá tất cả tokens → force logout → redirect về /login
```

---

### 4.4 Logout

```
POST /api/auth/logout
  → auth-service gọi Keycloak:
      POST /realms/bin-ecommerce/protocol/openid-connect/logout
      { client_id, client_secret, refresh_token }
  → Keycloak blacklist refresh token
  → auth-service xoá refresh token trong DB
  → Frontend xoá accessToken (Redux state) + refreshToken cookie
```

---

## 5. JWT Token — cấu trúc và lifecycle

### Cấu trúc JWT payload (decode từ `access_token`)

```json
{
  "exp": 1745500800,
  "iat": 1745499900,
  "auth_time": 1745499900,
  "jti": "abc123-unique-token-id",
  "iss": "http://keycloak:8080/realms/bin-ecommerce",
  "aud": "account",
  "sub": "550e8400-e29b-41d4-a716-446655440000",   ← User ID (UUID)
  "typ": "Bearer",
  "azp": "api-gateway",
  "session_state": "...",
  "realm_access": {
    "roles": ["USER", "offline_access", "uma_authorization"]
  },
  "resource_access": { ... },
  "scope": "openid email profile",
  "sid": "...",
  "email_verified": true,
  "name": "Nguyen Van A",
  "preferred_username": "user@example.com",
  "given_name": "Van A",
  "family_name": "Nguyen",
  "email": "user@example.com",
  "roles": ["USER"]   ← custom mapper inject vào
}
```

**Field quan trọng:**
| Field | Mô tả | Dùng ở đâu |
|-------|-------|------------|
| `sub` | User ID (UUID Keycloak) | `X-User-Id` header |
| `email` | Email user | `X-User-Email` header |
| `roles` | Custom claim từ protocol mapper | `X-User-Roles` header |
| `exp` | Expiry timestamp | JWT verify auto check |
| `iss` | Issuer = realm URL | JWT verify validate issuer |

---

### Algorithm: RS256

Keycloak ký token bằng **RS256** (RSA + SHA-256):
- Keycloak giữ **private key** → ký token
- API Gateway dùng **public key** (lấy từ JWKS) → verify

Lợi thế: gateway verify token **offline** mà không cần gọi Keycloak mỗi request.

---

## 6. JWKS — cách Gateway verify token

**JWKS** = JSON Web Key Set — endpoint public để lấy public key của Keycloak.

```
GET http://keycloak:8080/realms/bin-ecommerce/protocol/openid-connect/certs

Response:
{
  "keys": [
    {
      "kid": "abc123",          ← Key ID
      "kty": "RSA",
      "alg": "RS256",
      "use": "sig",
      "n": "...",               ← RSA modulus (base64url)
      "e": "AQAB"              ← RSA exponent
    }
  ]
}
```

### Quy trình verify trong `JwksService`

```typescript
// 1. Decode token (không verify) → lấy header.kid
const decoded = jwt.decode(token, { complete: true });
const kid = decoded.header.kid;   // "abc123"

// 2. Fetch public key theo kid (cached 1 giờ)
const key = await jwksClient.getSigningKey(kid);
const publicKey = key.getPublicKey();

// 3. Verify signature + expiry + issuer
jwt.verify(token, publicKey, {
  algorithms: ['RS256'],
  issuer: 'http://keycloak:8080/realms/bin-ecommerce'
});
```

**Tại sao cache 1 giờ?**  
Keycloak không thường xuyên rotate keys. Cache giúp:
- Giảm latency (không cần HTTP call đến Keycloak)
- Giảm load lên Keycloak server

**Key rotation:** Nếu Keycloak rotate key, `getSigningKey(kid)` sẽ miss cache → fetch lại automatically.

---

## 7. Password Policy

Cấu hình trong `bin-ecommerce-realm.json`:

```
length(8)       → tối thiểu 8 ký tự
upperCase(1)    → ít nhất 1 chữ HOA
lowerCase(1)    → ít nhất 1 chữ thường
digits(1)       → ít nhất 1 chữ số
specialChars(1) → ít nhất 1 ký tự đặc biệt (!@#$...)
notUsername     → không trùng username
notEmail        → không trùng email
```

**Ví dụ mật khẩu hợp lệ:** `MyPass@123`  
**Ví dụ không hợp lệ:** `password` (không có hoa, số, special)

Keycloak tự động validate khi gọi ROPC. Nếu sai policy → HTTP 400 với message từ Keycloak.

---

## 8. Brute Force Protection

```json
{
  "bruteForceProtected": true,
  "failureFactor": 5,
  "waitIncrementSeconds": 60,
  "maxFailureWaitSeconds": 900,
  "maxDeltaTimeSeconds": 43200
}
```

- Sau **5 lần** đăng nhập sai → tài khoản bị **lock tạm thời**
- Thời gian khóa tăng dần: 1 phút → 2 phút → ... → tối đa 15 phút
- Admin có thể unlock thủ công trong Keycloak Admin Console

**Kết hợp với Nginx rate limiting:**
```
Nginx: 10 req/min cho auth endpoints  → limit số request từ 1 IP
Keycloak: khóa sau 5 lần sai          → protect từng account cụ thể
```

---

## 9. Realm Import tự động

Keycloak start với flag `--import-realm` và mount thư mục:

```yaml
# docker-compose.infra.yml
keycloak:
  command: start-dev --import-realm
  volumes:
    - ./infra/keycloak/realm-export:/opt/keycloak/data/import
```

Keycloak sẽ:
1. Scan thư mục `/opt/keycloak/data/import`
2. Import tất cả file `*.json` tìm thấy
3. Bỏ qua nếu realm đã tồn tại (idempotent)

**Lợi ích**: `docker compose down -v && docker compose up` → Keycloak được cấu hình đầy đủ tự động, không cần setup tay qua Admin UI.

---

## 10. Các API Keycloak sử dụng trong hệ thống

### 10.1 Login (ROPC)

```http
POST /realms/bin-ecommerce/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=password
&client_id=api-gateway
&client_secret=changeme_keycloak_secret
&username=user@example.com
&password=P@ssw0rd123
&scope=openid
```

**Response:**
```json
{
  "access_token": "eyJhbGc...",
  "expires_in": 900,
  "refresh_expires_in": 604800,
  "refresh_token": "eyJhbGc...",
  "token_type": "Bearer",
  "session_state": "...",
  "scope": "openid email profile"
}
```

---

### 10.2 Refresh Token

```http
POST /realms/bin-ecommerce/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&client_id=api-gateway
&client_secret=changeme_keycloak_secret
&refresh_token=eyJhbGc...
```

---

### 10.3 Logout

```http
POST /realms/bin-ecommerce/protocol/openid-connect/logout
Content-Type: application/x-www-form-urlencoded

client_id=api-gateway
&client_secret=changeme_keycloak_secret
&refresh_token=eyJhbGc...
```

---

### 10.4 Đăng ký User mới (Admin API)

Keycloak không có endpoint đăng ký user từ client thông thường — phải dùng **Admin REST API**:

```http
POST /admin/realms/bin-ecommerce/users
Authorization: Bearer <admin_access_token>
Content-Type: application/json

{
  "username": "user@example.com",
  "email": "user@example.com",
  "firstName": "Van A",
  "lastName": "Nguyen",
  "enabled": true,
  "credentials": [{
    "type": "password",
    "value": "P@ssw0rd123",
    "temporary": false
  }]
}
```

**auth-service** cần lấy admin token trước:
```http
POST /realms/master/protocol/openid-connect/token
grant_type=client_credentials
client_id=api-gateway
client_secret=...
```

---

### 10.5 JWKS (Public Keys)

```http
GET /realms/bin-ecommerce/protocol/openid-connect/certs
```

---

### 10.6 Introspect Token (optional — không dùng offline verify)

```http
POST /realms/bin-ecommerce/protocol/openid-connect/token/introspect
client_id=api-gateway
&client_secret=...
&token=eyJhbGc...
```

> Hệ thống này dùng **offline verify** (JWKS) thay vì introspect để tránh Keycloak trở thành bottleneck.

---

## 11. Nginx Rate Limiting kết hợp Keycloak

```
Layer 1 — Nginx (infra/nginx/conf.d/default.conf):
  api_global:    100 req/min/IP cho tất cả /api/*
  auth_strict:   10 req/min/IP cho /api/auth/login|register|refresh|...

Layer 2 — Keycloak:
  Brute force: khóa user sau 5 lần sai

Layer 3 — NestJS Throttler (trong mỗi service):
  ThrottlerModule: 100 req/min (fallback nếu đến trực tiếp service)
```

**Kịch bản tấn công brute force:**
```
Attacker cố login 1000 lần → Nginx block sau 10 req/min → Keycloak block account sau 5 lần sai
```

---

## 12. Xử lý lỗi thường gặp

### Lỗi: `JWT expired`
- **Nguyên nhân**: access_token hết hạn (15 phút)
- **Xử lý**: Frontend tự động gọi `/api/auth/refresh` (silent refresh trong `authorizedAxios.ts`)

### Lỗi: `invalid_grant`
- **Nguyên nhân**: refresh_token hết hạn (7 ngày) hoặc đã bị thu hồi
- **Xử lý**: Logout user, redirect về trang login

### Lỗi: `Account is not fully set up`
- **Nguyên nhân**: User chưa verify email
- **Xử lý**: Hiển thị trang yêu cầu verify email

### Lỗi: `Account disabled`
- **Nguyên nhân**: Brute force protection đã khóa account
- **Xử lý**: Hiển thị message "Tài khoản tạm thời bị khóa, thử lại sau X phút"

### Lỗi Gateway: `ECONNREFUSED` đến Keycloak
- **Nguyên nhân**: Keycloak chưa start
- **Xử lý**: `docker compose -f infra/docker/docker-compose.infra.yml up -d keycloak`

### Lỗi: JWKS request fail
- **Nguyên nhân**: Keycloak URL sai hoặc Keycloak down
- **Hậu quả**: Gateway không verify được bất kỳ token nào → tất cả request fail với 401
- **Xử lý**: Kiểm tra `KEYCLOAK_URL` và `KEYCLOAK_REALM` trong `.env`

---

## Tài nguyên

- [Keycloak Admin Console](http://localhost:8080) — `admin / changeme_admin`
- [Keycloak API Docs](https://www.keycloak.org/docs-api/24.0/rest-api/)
- [OIDC Discovery](http://localhost:8080/realms/bin-ecommerce/.well-known/openid-configuration)
- File cấu hình realm: [infra/keycloak/realm-export/bin-ecommerce-realm.json](../../infra/keycloak/realm-export/bin-ecommerce-realm.json)
