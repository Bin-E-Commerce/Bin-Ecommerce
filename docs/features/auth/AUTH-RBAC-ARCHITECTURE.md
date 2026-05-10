# Auth & RBAC Architecture

## 1. Tổng quan thành phần (C4 Context)

```plantuml
@startuml C4_Context
skinparam shadowing false
skinparam backgroundColor #FEFEFE
skinparam rectangle {
  BackgroundColor #dae8fc
  BorderColor #6c8ebf
}
skinparam actor {
  BackgroundColor #d5e8d4
  BorderColor #82b366
}
skinparam database {
  BackgroundColor #fff2cc
  BorderColor #d6b656
}
skinparam cloud {
  BackgroundColor #f8cecc
  BorderColor #b85450
}

title Auth & RBAC — System Context

actor "End User\n(Browser / Mobile)" as User
actor "Admin / Staff\n(Back-office)" as Admin

rectangle "API Gateway :3000" {
  rectangle "JwtAuthGuard\nVerify RS256 JWT via JWKS" as JwtGuard
  rectangle "RolesGuard\nEnforce @Roles() metadata" as RolesGuard
  rectangle "ProxyService\nForward requests downstream" as Proxy
}

rectangle "Auth Service :3001" {
  rectangle "AuthController\nRegister/Login/Social/Refresh/Logout" as AuthCtrl
  rectangle "UserController\nProfile / Addresses" as UserCtrl
  rectangle "AdminUserController\nAdmin: list / role / status" as AdminCtrl
  rectangle "AuthService\nBusiness logic" as AuthSvc
  rectangle "OtpService\nGenerate & verify OTP" as OtpSvc
  rectangle "TokenService\nROPC / Refresh / Exchange code" as TokenSvc
  rectangle "KeycloakAdminService\nManage users via Admin REST API" as KcAdmin
}

cloud "Keycloak 24\nIAM — issue JWT\nsocial IdP" as Keycloak
database "PostgreSQL 16\nusers, refresh_tokens" as Postgres
database "Redis 7\nOTP challenges (TTL 10m)" as Redis

User --> JwtGuard : HTTPS + Bearer token
Admin --> JwtGuard : HTTPS + Bearer token
JwtGuard --> Keycloak : JWKS public key fetch
Proxy --> AuthCtrl : HTTP (x-user-* headers injected)
AuthSvc --> Keycloak : Admin REST API (client_credentials)
TokenSvc --> Keycloak : ROPC / refresh_token / auth_code
AuthSvc --> Postgres : TypeORM
OtpSvc --> Redis : ioredis — HSET / HINCRBY / DEL + TTL
@enduml
```

---

## 2. Chi tiết luồng Register (OTP)

```plantuml
@startuml Register_Sequence
skinparam shadowing false
skinparam sequenceMessageAlign center
skinparam sequence {
  ArrowColor #333333
  LifeLineBorderColor #666666
  ParticipantBackgroundColor #dae8fc
  ParticipantBorderColor #6c8ebf
}

title Register Flow — OTP via Redis

actor Client as C
participant "API Gateway" as GW
participant "Auth Service" as AS
database "Redis" as R
database "PostgreSQL" as DB
participant "Keycloak" as KC

autonumber

C -> GW : POST /api/v1/auth/register/initiate\n{email, password, name}
note right of GW : @Public() — skip JwtAuthGuard
GW -> AS : proxy (no auth headers)
AS -> DB : SELECT users WHERE email = ?
DB --> AS : null (email not exists)
AS -> R : pipeline:\n  DEL otp:REGISTER:<email>\n  HSET {otp_hash, resend_at,\n        attempts=0, extra_data}\n  EXPIRE 600s
AS --> C : 200 {message, expiresIn: 600}
note right of AS : [DEV] log OTP to console

C -> GW : POST /api/v1/auth/register/verify\n{identifier, otp}
GW -> AS : proxy
AS -> R : HGETALL otp:REGISTER:<email>
R --> AS : {otp_hash, attempts, ...}
AS -> R : HINCRBY attempts 1  ← atomic
AS -> AS : compare SHA-256(input) == otp_hash
AS -> KC : POST /users (Admin REST API)
KC --> AS : keycloakId
AS -> DB : INSERT users
AS -> KC : assign realm role CUSTOMER
AS -> KC : POST /token (ROPC grant)
KC --> AS : {access_token, refresh_token}
AS -> DB : INSERT refresh_tokens (hash only)
AS -> R : DEL otp:REGISTER:<email>
AS --> C : 201 {accessToken, refreshToken, user}
@enduml
```

---

## 3. Chi tiết luồng Login

```plantuml
@startuml Login_Sequence
skinparam shadowing false
skinparam sequence {
  ArrowColor #333333
  ParticipantBackgroundColor #dae8fc
  ParticipantBorderColor #6c8ebf
}

title Login Flow

actor Client as C
participant "API Gateway" as GW
participant "Auth Service" as AS
participant "Keycloak" as KC
database "PostgreSQL" as DB

autonumber

C -> GW : POST /api/v1/auth/login\n{email, password}
note right of GW : @Public()
GW -> AS : proxy
AS -> KC : POST /token\n(grant_type=password)
KC --> AS : {access_token, refresh_token, expires_in}
AS -> DB : SELECT users WHERE email = ?
DB --> AS : user {status, role, ...}
AS -> DB : UPDATE users SET last_login_at = NOW()
AS -> DB : INSERT refresh_tokens\n(token_hash, expires_at, ip, user_agent)
AS --> C : 200 {accessToken, refreshToken,\n           expiresIn, user}
@enduml
```

---

## 4. Chi tiết luồng Refresh Token (với Theft Detection)

```plantuml
@startuml Refresh_Sequence
skinparam shadowing false
skinparam sequence {
  ArrowColor #333333
  ParticipantBackgroundColor #dae8fc
  ParticipantBorderColor #6c8ebf
}

title Refresh Token Flow — Theft Detection

actor Client as C
participant "API Gateway" as GW
participant "Auth Service" as AS
participant "Keycloak" as KC
database "PostgreSQL" as DB

autonumber

C -> GW : POST /api/v1/auth/refresh\n{refreshToken}
note right of GW : @Public()
GW -> AS : proxy
AS -> AS : hash = SHA-256(refreshToken)
AS -> DB : SELECT refresh_tokens\nWHERE token_hash = hash

alt Token đã bị revoke (theft detected)
  DB --> AS : row {revoked_at IS NOT NULL}
  AS -> DB : DELETE refresh_tokens WHERE user_id = ?
  note right of AS : Xoá toàn bộ session của user
  AS --> C : 401 Unauthorized
else Token hết hạn
  DB --> AS : row {expires_at < NOW()}
  AS --> C : 401 Unauthorized
else Token hợp lệ
  DB --> AS : row valid
  AS -> DB : UPDATE SET revoked_at = NOW()
  AS -> KC : POST /token\n(grant_type=refresh_token)
  KC --> AS : new {access_token, refresh_token}
  AS -> DB : INSERT new refresh_tokens
  AS --> C : 200 {accessToken, refreshToken}
end
@enduml
```

---

## 5. Chi tiết luồng Social Login (OAuth Authorization Code + PKCE)

```plantuml
@startuml Social_Login_Sequence
skinparam shadowing false
skinparam sequence {
  ArrowColor #333333
  ParticipantBackgroundColor #dae8fc
  ParticipantBorderColor #6c8ebf
}

title Social Login — OAuth Authorization Code + PKCE

actor "Client (Browser)" as C
participant "API Gateway" as GW
participant "Auth Service" as AS
participant "Keycloak" as KC
participant "Google / Facebook" as IdP
database "PostgreSQL" as DB

autonumber

C -> GW : GET /api/v1/auth/social/start/google
note right of GW : @Public()
GW -> AS : proxy
AS -> AS : generate state UUID\n(in-memory, TTL 10m)
AS --> C : 200 {authUrl, state}

C -> KC : Redirect → authUrl\n(kc_idp_hint=google)
KC -> IdP : Redirect → Google OAuth
IdP --> C : Redirect → /auth/callback\n?code=...&state=...
C -> GW : POST /api/v1/auth/social/callback/google\n{code, state}
GW -> AS : proxy
AS -> AS : verify state (CSRF check)
AS -> KC : POST /token\n(grant_type=authorization_code)
KC --> AS : {access_token, refresh_token, id_token}
AS -> AS : decode id_token\n→ keycloakId, email, name
AS -> DB : INSERT/UPDATE users
AS --> C : 200 {accessToken, refreshToken, user}
@enduml
```

---

## 6. Luồng RBAC tại API Gateway

```plantuml
@startuml RBAC_Activity
skinparam shadowing false
skinparam activity {
  BackgroundColor #dae8fc
  BorderColor #6c8ebf
  DiamondBackgroundColor #fff2cc
  DiamondBorderColor #d6b656
}

title RBAC Flow — API Gateway

|#f5f5f5| JwtAuthGuard (APP_GUARD #1)|
start
:Incoming Request;
if (Route có @Public()?) then (yes)
  :Pass — skip auth;
else (no)
  :Extract Bearer token;
  :Decode JWT → lấy kid;
  :Fetch JWKS public key từ Keycloak;
  :Verify RS256 chữ ký + issuer;
  if (Token valid?) then (no)
    #pink:401 Unauthorized;
    stop
  else (yes)
    :Inject headers:\nx-user-id = sub\nx-user-email = email\nx-user-roles = roles.join(",");
  endif
endif

|#e8f5e9| RolesGuard (APP_GUARD #2)|
if (Route có @Public()?) then (yes)
  :Pass — no role check;
else (no)
  if (Route có @Roles() metadata?) then (no)
    :Pass — auth-only route;
  else (yes)
    :Đọc x-user-roles header;
    if (userRoles includes ADMIN?) then (yes)
      :Pass — ADMIN bypass;
    else (no)
      if (userRoles ∩ requiredRoles ≠ ∅?) then (yes)
        :Pass;
      else (no)
        #pink:403 Forbidden;
        stop
      endif
    endif
  endif
endif

|#fff8e1| ProxyService|
:Forward request + x-user-* headers\nđến downstream service;
stop
@enduml
```

---

## 7. Entity Relationship Diagram

```plantuml
@startuml ERD
skinparam shadowing false
skinparam entity {
  BackgroundColor #dae8fc
  BorderColor #6c8ebf
}

title Database Schema — Auth Service

entity users {
  * id : uuid <<PK>>
  --
  * email : varchar <<UK>>
  * name : varchar
  phone : varchar
  * keycloak_id : varchar <<UK>>
  * role : varchar
  * status : varchar
  avatar_url : text
  last_login_at : timestamptz
  * created_at : timestamptz
  * updated_at : timestamptz
}

entity user_addresses {
  * id : uuid <<PK>>
  --
  * user_id : uuid <<FK>>
  * label : varchar
  * full_name : varchar
  * phone : varchar
  * province : varchar
  * district : varchar
  * ward : varchar
  * street : text
  * is_default : boolean
  * created_at : timestamptz
}

entity refresh_tokens {
  * id : uuid <<PK>>
  --
  * user_id : uuid <<FK>>
  * token_hash : varchar
  * issued_at : timestamptz
  * expires_at : timestamptz
  revoked_at : timestamptz
  ip_address : varchar
  user_agent : text
}

users ||--o{ user_addresses : "has"
users ||--o{ refresh_tokens : "has"
@enduml
```

**Redis (ngoài SQL):**

```
Key:   otp:{purpose}:{identifier}
Type:  Hash
TTL:   600s (auto-expire)

Fields:
  otp_hash      — SHA-256(raw_otp)
  resend_at     — Unix ms timestamp (cooldown 60s)
  attempts      — int (max 3, HINCRBY atomic)
  max_attempts  — int (default 3)
  extra_data    — JSON string (register: {name, phone, passwordForKc})
```

---

## 8. Class Diagram — Auth Service

```plantuml
@startuml Class_Diagram
skinparam shadowing false
skinparam class {
  BackgroundColor #dae8fc
  BorderColor #6c8ebf
  ArrowColor #333333
}

title Class Diagram — Auth Service + API Gateway

class AuthController {
  +registerInitiate(dto) : Promise
  +registerVerify(dto, req) : Promise
  +login(dto, req) : Promise
  +refresh(dto) : Promise
  +logout(dto, req) : Promise
  +socialStart(provider) : Promise
  +socialCallback(provider, dto, req) : Promise
}

class AuthService {
  -userRepo : Repository<User>
  -refreshTokenRepo : Repository<RefreshToken>
  -keycloakAdmin : KeycloakAdminService
  -otpService : OtpService
  -tokenService : TokenService
  -socialStateStore : Map
  +registerInitiate(dto) : Promise
  +registerVerify(dto, ip, ua) : Promise
  +login(dto, ip, ua) : Promise
  +getSocialAuthUrl(provider) : Object
  +socialCallback(provider, dto, ip, ua) : Promise
  +refresh(dto, ip, ua) : Promise
  +logout(userId, refreshToken) : Promise
  -saveRefreshToken(userId, token, ttl, ip, ua) : Promise
  -safeUser(user) : Partial<User>
}

class OtpService {
  -redis : Redis
  -OTP_TTL_SECONDS : 600
  -MAX_ATTEMPTS : 3
  -RESEND_COOLDOWN_MS : 60000
  +createChallenge(identifier, purpose, extraData?) : Promise<string>
  +verifyOtp(identifier, purpose, input) : Promise
  +sendOtp(identifier, code, channel) : Promise
  -key(purpose, identifier) : string
  -hashOtp(raw) : string
  -generateCode() : string
}

class TokenService {
  +issueTokenPair(email, password) : Promise<TokenPair>
  +rotateRefreshToken(refreshToken) : Promise<TokenPair>
  +exchangeCode(code, redirectUri) : Promise<TokenPair>
  +revokeToken(refreshToken) : Promise
  +hashToken(raw) : string
}

class KeycloakAdminService {
  -cachedToken : string
  -tokenExpiresAt : number
  +createUser(email, password, name) : Promise<string>
  +deleteUser(keycloakId) : Promise
  +assignRealmRole(keycloakId, role) : Promise
  +removeRealmRole(keycloakId, role) : Promise
  +setUserEnabled(keycloakId, enabled) : Promise
  -getAdminToken() : Promise<string>
}

class JwtAuthGuard {
  -jwksService : JwksService
  -reflector : Reflector
  +canActivate(ctx) : Promise<boolean>
  -extractToken(req) : string
}

class RolesGuard {
  -reflector : Reflector
  +canActivate(ctx) : boolean
}

class JwksService {
  -client : JwksClient
  -expectedIssuer : string
  +verifyToken(token) : Promise<JwtPayload>
}

AuthController --> AuthService
AuthService --> OtpService
AuthService --> TokenService
AuthService --> KeycloakAdminService
JwtAuthGuard --> JwksService
RolesGuard --> Reflector
@enduml
```

---

## 9. Ưu & Nhược điểm

### ✅ Ưu điểm

| Khía cạnh                         | Chi tiết                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Bảo mật token**                 | JWT RS256 — private key nằm trong Keycloak, gateway chỉ cần public key qua JWKS. Không cần shared secret |
| **Stateless verification**        | Gateway verify token hoàn toàn offline sau khi cache JWKS. Không cần gọi auth-service mỗi request        |
| **Refresh token theft detection** | Dùng token rotation + detect reuse: nếu token đã revoke được dùng lại → xoá toàn bộ session              |
| **OTP brute-force protection**    | `HINCRBY` atomic trên Redis — không thể race condition, tự expire sau 10 phút                            |
| **OTP resend cooldown**           | 60s cooldown lưu trong Redis hash, không cần bảng riêng                                                  |
| **Compensating transaction**      | Nếu DB insert user thất bại sau khi tạo trên Keycloak → tự động xoá Keycloak user                        |
| **CSRF protection (social)**      | State UUID lưu in-memory với TTL 10 phút, verify trước khi exchange code                                 |
| **ADMIN bypass**                  | ADMIN role bypass toàn bộ `@Roles()` check — không cần liệt kê trong mọi route                           |
| **Header injection**              | Gateway inject `x-user-*` một lần → downstream không cần xác thực lại JWT                                |
| **Tách biệt concern**             | Auth logic ở auth-service, traffic control ở gateway — mỗi thứ làm đúng vai trò                          |

### ⚠️ Nhược điểm & Hạn chế hiện tại

| Khía cạnh                              | Chi tiết                                                                                                               | Hướng giải quyết                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Token không thể revoke ngay**        | Access token RS256 có hiệu lực đến khi hết TTL (15 phút) dù logout — gateway chỉ verify chữ ký, không check blacklist  | Thêm Redis token blacklist hoặc giảm access token TTL xuống 5 phút |
| **ROPC flow (deprecated)**             | `grant_type=password` bị deprecated trong OAuth 2.1. Keycloak vẫn hỗ trợ nhưng không được khuyến nghị cho production   | Migrate sang Authorization Code + PKCE ngay cả với first-party app |
| **`passwordForKc` lưu trong Redis**    | `extraData` chứa password plaintext trong Redis TTL 10 phút khi đăng ký. SECURITY_TODO đã ghi chú                      | Encrypt `extraData` bằng AES-GCM với key từ env trước khi lưu      |
| **Social state in-memory**             | `socialStateStore` là Map trong process memory — mất khi restart, không scale ngang                                    | Migrate sang Redis với TTL 10 phút                                 |
| **Keycloak Admin token cache**         | Cache in-memory, mất khi restart. Nếu nhiều pod thì mỗi pod có 1 cache riêng                                           | Dùng Redis để share cache token giữa các pod                       |
| **Không có token introspection**       | Downstream service tin tuyệt đối `x-user-*` header từ gateway — nếu gateway bị bypass thì không có lớp bảo vệ nào      | Thêm internal mTLS hoặc signed header giữa gateway và services     |
| **Kafka TODO**                         | `user.registered`, `user.role-changed`, `user.status-changed` chưa publish — các service khác không biết user thay đổi | Implement Kafka producer trong auth-service                        |
| **OtpChallenge entity còn tồn tại**    | Entity `OtpChallenge` vẫn còn trong codebase dù không dùng nữa                                                         | Tạo migration drop table, xoá entity file                          |
| **Không có rate limit riêng cho auth** | ThrottlerModule áp 100 req/min toàn gateway — `/auth/login` và `/auth/register` nên có limit thấp hơn nhiều            | Dùng `@Throttle()` riêng cho auth routes: 5 req/min                |
