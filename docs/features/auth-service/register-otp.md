# Auth Service - Registration with OTP

## Source Files

- `services/auth-service/src/modules/auth/controllers/auth.controller.ts`
- `services/auth-service/src/modules/auth/services/auth.service.ts`
- `services/auth-service/src/modules/auth/services/otp.service.ts`
- `services/auth-service/src/modules/auth/services/keycloak-admin.service.ts`
- `services/auth-service/src/modules/auth/services/token.service.ts`
- `services/auth-service/src/modules/auth/dto/register-initiate.dto.ts`
- `services/auth-service/src/modules/auth/dto/register-verify.dto.ts`

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/auth/register/initiate` | Validate registration input and send OTP |
| `POST` | `/api/v1/auth/register/verify` | Verify OTP, create user, issue token pair |

Both routes are public at the API Gateway.

## Request: Register Initiate

```json
{
  "email": "user@example.com",
  "password": "Password1",
  "name": "Nguyen Van A",
  "phone": "0912345678"
}
```

Validation from `RegisterInitiateDto`:

| Field | Rule |
| --- | --- |
| `email` | email, max 255 |
| `password` | string, min 8, max 100, at least one uppercase letter and one digit |
| `name` | string, min 2, max 100 |
| `phone` | optional, must match `^0[3-9][0-9]{8}$` |

## Initiate Flow

```mermaid
sequenceDiagram
  autonumber
  participant Client
  participant Controller as AuthController
  participant Auth as AuthService
  participant Users as User Repository
  participant OTP as OtpService
  participant Kafka as KafkaProducerService
  participant Notification as Notification Service

  Client->>Controller: POST /auth/register/initiate
  Controller->>Auth: registerInitiate(dto)
  Auth->>Auth: lowercase dto.email
  Auth->>Users: findOne({ email })
  alt user exists
    Auth-->>Controller: ConflictException("Email already registered")
  else new email
    Auth->>OTP: createChallenge(email, REGISTER, extraData)
    OTP->>OTP: enforce resend cooldown
    OTP->>OTP: generate 6-digit code
    OTP->>OTP: hash OTP with SHA-256
    OTP->>OTP: store Redis hash with TTL 600s
    Auth->>OTP: sendOtp(email, rawOtp, "email")
    OTP->>Kafka: publish notification.otp-requested
    Kafka-->>Notification: OTP event consumed asynchronously
    Auth-->>Controller: { message, expiresIn: 600 }
  end
```

## Redis OTP Data

`OtpService.createChallenge()` stores a Redis hash at:

```text
otp:REGISTER:<email>
```

Fields written:

| Field | Meaning |
| --- | --- |
| `otp_hash` | SHA-256 hash of raw OTP |
| `resend_at` | timestamp in milliseconds before next OTP is allowed |
| `attempts` | starts at `0` |
| `max_attempts` | `3` |
| `extra_data` | JSON containing `name`, `phone`, `passwordForKc` |

TTL is `600` seconds.

## Request: Register Verify

```json
{
  "identifier": "user@example.com",
  "otp": "123456"
}
```

Validation from `RegisterVerifyDto`:

| Field | Rule |
| --- | --- |
| `identifier` | email |
| `otp` | string length exactly 6 |

## Verify Flow

```mermaid
sequenceDiagram
  autonumber
  participant Client
  participant Controller as AuthController
  participant Auth as AuthService
  participant OTP as OtpService
  participant Keycloak as KeycloakAdminService
  participant DB as PostgreSQL
  participant Token as TokenService

  Client->>Controller: POST /auth/register/verify
  Controller->>Auth: registerVerify(dto, ip, userAgent)
  Auth->>OTP: verifyOtp(identifier, REGISTER, otp)
  OTP->>OTP: hgetall Redis key
  OTP->>OTP: increment attempts
  alt invalid or too many attempts
    OTP-->>Auth: BadRequest or TooManyRequests
  else valid OTP
    OTP->>OTP: delete Redis key
    OTP-->>Auth: extra_data
  end
  Auth->>Keycloak: createUser(email, password, name)
  Keycloak-->>Auth: keycloakId
  Auth->>DB: create local User
  alt local DB insert fails
    Auth->>Keycloak: deleteUser(keycloakId)
    Auth-->>Controller: throw original error
  else local user saved
    Auth->>Keycloak: assignRealmRole(CUSTOMER)
    Auth->>Token: issueTokenPair(email, password)
    Token-->>Auth: accessToken, refreshToken, expiresIn, refreshExpiresIn
    Auth->>DB: save refresh token hash + expiry + ip + userAgent
    Auth-->>Controller: AuthResponse
    Controller->>Controller: set refresh_token HTTP-only cookie
    Controller-->>Client: safe response without refreshToken body field
  end
```

## Response

`AuthController.registerVerify()` sets the `refresh_token` cookie and removes `refreshToken` from the JSON body.

Cookie options:

| Option | Value |
| --- | --- |
| `httpOnly` | `true` |
| `secure` | `NODE_ENV === "production"` |
| `sameSite` | `lax` |
| `path` | `/api/v1/auth` |
| `maxAge` | 7 days |

Body shape:

```json
{
  "data": {
    "accessToken": "...",
    "expiresIn": 300,
    "user": {
      "id": "...",
      "email": "user@example.com",
      "name": "Nguyen Van A",
      "phone": "0912345678",
      "role": "CUSTOMER",
      "status": "ACTIVE",
      "avatarUrl": null,
      "createdAt": "..."
    }
  },
  "message": "Registration successful",
  "statusCode": 201
}
```

## Important Implementation Notes

- `passwordForKc` is stored temporarily in Redis `extra_data`; source code marks this with `SECURITY_TODO: encrypt before production`.
- Keycloak user creation happens before local DB insert.
- If local DB insert fails, `AuthService` compensates by deleting the Keycloak user.
- Role assignment failure is logged but does not fail registration.
