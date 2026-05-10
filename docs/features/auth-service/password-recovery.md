# Auth Service - Forgot Password and Reset Password

## Source Files

- `services/auth-service/src/modules/auth/controllers/auth.controller.ts`
- `services/auth-service/src/modules/auth/services/auth.service.ts`
- `services/auth-service/src/modules/auth/services/otp.service.ts`
- `services/auth-service/src/modules/auth/services/keycloak-admin.service.ts`
- `services/auth-service/src/modules/auth/dto/forgot-password.dto.ts`
- `services/auth-service/src/modules/auth/dto/reset-password.dto.ts`

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/auth/forgot-password` | Create reset-password OTP when eligible |
| `POST` | `/api/v1/auth/reset-password` | Verify OTP, reset Keycloak password, revoke sessions |

These routes are handled by `AuthController`. In the gateway, they fall under the auth proxy wildcard unless explicitly listed as public.

## Forgot Password Request

```json
{
  "email": "user@example.com"
}
```

Validation:

- `email`: valid email, max length 255.

## Forgot Password Flow

```mermaid
sequenceDiagram
  autonumber
  participant Client
  participant Controller
  participant Auth as AuthService
  participant DB as User Repository
  participant OTP as OtpService
  participant Kafka

  Client->>Controller: POST /auth/forgot-password
  Controller->>Auth: forgotPassword(dto)
  Auth->>Auth: lowercase email
  Auth->>Auth: prepare generic response
  Auth->>DB: find user by email
  alt user missing or not ACTIVE
    Auth-->>Controller: generic response
  else user ACTIVE
    Auth->>OTP: createChallenge(email, RESET_PASSWORD)
    OTP->>OTP: store hashed OTP in Redis, TTL 600s
    Auth->>OTP: sendOtp(email, rawOtp, "email")
    OTP->>Kafka: publish notification.otp-requested
    Auth-->>Controller: generic response
  end
```

## Enumeration Protection

The service always returns the same message whether the email exists or not:

```json
{
  "message": "If the email exists, an OTP has been sent",
  "expiresIn": 600
}
```

## Reset Password Request

```json
{
  "identifier": "user@example.com",
  "otp": "123456",
  "newPassword": "NewPassword1"
}
```

Validation:

| Field | Rule |
| --- | --- |
| `identifier` | email, max 255 |
| `otp` | exactly six digits |
| `newPassword` | string, min 8, max 128, at least one uppercase letter and one digit |

## Reset Password Flow

```mermaid
sequenceDiagram
  autonumber
  participant Client
  participant Controller
  participant Auth as AuthService
  participant OTP as OtpService
  participant DB as PostgreSQL
  participant Keycloak as KeycloakAdminService

  Client->>Controller: POST /auth/reset-password
  Controller->>Auth: resetPassword(dto)
  Auth->>OTP: verifyOtp(identifier, RESET_PASSWORD, otp)
  alt OTP invalid
    OTP-->>Auth: BadRequest or TooManyRequests
  else OTP valid
    OTP->>OTP: delete Redis challenge
    Auth->>DB: find user by email
    alt user missing
      Auth-->>Controller: NotFoundException("User not found")
    else user not ACTIVE
      Auth-->>Controller: UnauthorizedException
    else user ACTIVE
      Auth->>Keycloak: resetUserPassword(keycloakId, newPassword)
      Auth->>DB: revoke all refresh tokens for user
      Auth-->>Controller: Password reset successful
    end
  end
```

## Session Impact

After password reset, code revokes all refresh tokens for the user:

```ts
await this.refreshTokenRepo.update(
  { userId: user.id },
  { revokedAt: new Date() },
);
```

This forces all existing sessions to log in again.

## Important Implementation Detail

`OtpService.sendOtp()` currently publishes the Kafka payload with `purpose: "REGISTER"` regardless of the OTP purpose passed to `createChallenge()`. The reset-password OTP is verified correctly under `OtpPurpose.RESET_PASSWORD`, but the notification email purpose label may not match reset-password intent until `sendOtp()` is adjusted to accept and publish the actual purpose.
