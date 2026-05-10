# Auth Service - Login, Refresh, and Logout

## Source Files

- `services/auth-service/src/modules/auth/controllers/auth.controller.ts`
- `services/auth-service/src/modules/auth/services/auth.service.ts`
- `services/auth-service/src/modules/auth/services/token.service.ts`
- `services/auth-service/src/database/entities/refresh-token.entity.ts`
- `services/auth-service/src/modules/auth/dto/login.dto.ts`
- `services/auth-service/src/modules/auth/dto/refresh.dto.ts`

## Endpoints

| Method | Path | Gateway Visibility | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/auth/login` | Public | Authenticate email/password and start session |
| `POST` | `/api/v1/auth/refresh` | Public | Rotate refresh token and issue new access token |
| `POST` | `/api/v1/auth/logout` | Protected by gateway wildcard | Revoke refresh token and clear cookie |

## Login Request

```json
{
  "email": "user@example.com",
  "password": "Password1"
}
```

Validation:

- `email` must be a valid email.
- `password` must be a non-empty string.

## Login Flow

```mermaid
sequenceDiagram
  autonumber
  participant Client
  participant Controller as AuthController
  participant Auth as AuthService
  participant DB as PostgreSQL
  participant Token as TokenService
  participant Keycloak

  Client->>Controller: POST /auth/login
  Controller->>Auth: login(dto, ip, userAgent)
  Auth->>DB: find user by lowercase email
  alt user not found
    Auth-->>Controller: UnauthorizedException("Account not found")
  else inactive/banned
    Auth-->>Controller: UnauthorizedException("Account is inactive or banned")
  else active
    Auth->>Token: issueTokenPair(email, password)
    Token->>Keycloak: password grant token request
    Keycloak-->>Token: access_token + refresh_token
    Auth->>DB: update lastLoginAt
    Auth->>DB: save SHA-256 hash of refresh token
    Controller->>Controller: set refresh_token cookie
    Controller-->>Client: access token + safe user
  end
```

## Refresh Flow

`AuthController.refresh()` reads the refresh token from:

1. HTTP-only cookie `refresh_token`
2. request body `refreshToken`

If both are missing, it throws:

```text
UnauthorizedException("Refresh token missing")
```

```mermaid
sequenceDiagram
  autonumber
  participant Client
  participant Controller
  participant Auth as AuthService
  participant DB as refresh_tokens table
  participant Token as TokenService
  participant Keycloak

  Client->>Controller: POST /auth/refresh
  Controller->>Controller: read cookie or body refreshToken
  Controller->>Auth: refresh(rawRefreshToken, ip, userAgent)
  Auth->>Auth: hash raw token with SHA-256
  Auth->>DB: find tokenHash with user relation
  alt missing/revoked/expired
    opt token was revoked
      Auth->>DB: revoke all tokens for userId
    end
    Auth-->>Controller: UnauthorizedException
  else valid
    Auth->>Token: rotateRefreshToken(rawRefreshToken)
    Token->>Keycloak: refresh_token grant
    Keycloak-->>Token: new token pair
    Auth->>DB: mark old token revokedAt = now
    Auth->>DB: save new refresh token hash
    Controller->>Controller: set new refresh_token cookie
    Controller-->>Client: new access token + safe user
  end
```

## Logout Flow

```mermaid
sequenceDiagram
  autonumber
  participant Client
  participant Gateway
  participant Controller
  participant Auth as AuthService
  participant DB as refresh_tokens table
  participant Keycloak

  Client->>Gateway: POST /api/v1/auth/logout + Bearer token
  Gateway->>Gateway: JWT required by auth proxy wildcard
  Gateway->>Controller: proxy to /api/v1/auth/logout
  Controller->>Controller: read cookie or body refreshToken
  opt token present
    Controller->>Auth: logout(token)
    Auth->>DB: update tokenHash revokedAt = now
    Auth->>Keycloak: revoke token
    opt Keycloak revoke fails
      Auth->>Auth: log warning only
    end
  end
  Controller->>Controller: clear refresh_token cookie
  Controller-->>Client: Logged out successfully
```

## Refresh Token Storage

`RefreshToken` entity stores:

| Column | Purpose |
| --- | --- |
| `user_id` | owner user |
| `token_hash` | SHA-256 hash, indexed |
| `issued_at` | created timestamp |
| `expires_at` | refresh token expiry from Keycloak |
| `revoked_at` | non-null means revoked |
| `ip_address` | request IP when token was saved |
| `user_agent` | request user-agent when token was saved |

## Security Behavior

- Raw refresh tokens are not stored in DB.
- Refresh token rotation revokes the old token before storing the new one.
- Reuse of a revoked token triggers revocation of all tokens for that user.
- JSON response never returns `refreshToken`; the controller strips it before returning.
