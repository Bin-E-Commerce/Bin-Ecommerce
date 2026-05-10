# Bin E-Commerce - Basic Setup Guide

This guide helps a new developer clone the main repository, initialize submodules, install dependencies, configure environment files, and run the current local development stack.

## 1. Prerequisites

Install these tools first:

| Tool           | Required Version | Notes                                            |
| -------------- | ---------------- | ------------------------------------------------ |
| Git            | latest stable    | Needed for the main repo and submodules          |
| Node.js        | `>= 20`          | Root `package.json` requires Node 20+            |
| npm            | `>= 10`          | Used by root workspace and submodules            |
| Docker Desktop | latest stable    | Needed for infrastructure and service containers |

If the repositories are private, make sure your GitHub account has access to the `Bin-E-Commerce` organization before cloning.

## 2. Clone the Main Repository

Recommended command:

```bash
git clone --recurse-submodules https://github.com/Bin-E-Commerce/Bin-E-Commerce.git
cd E-commerce
```

If you already cloned without submodules:

```bash
git submodule update --init --recursive
```

If a submodule points to an old commit after pulling:

```bash
git pull
git submodule update --init --recursive
```

## 3. Submodules Included

The main repository uses Git submodules for independently versioned apps/services.

| Path                            | Repository                                                                  |
| ------------------------------- | --------------------------------------------------------------------------- |
| `web`                           | `https://github.com/Bin-E-Commerce/Bin-E-Commerce-UI-Web.git`               |
| `services/api-gateway`          | `https://github.com/Bin-E-Commerce/Bin-E-Commerce-APIGateway.git`           |
| `services/auth-service`         | `https://github.com/Bin-E-Commerce/Bin-E-Commerce-Auth-Service.git`         |
| `services/notification-service` | `https://github.com/Bin-E-Commerce/Bin-E-Commerce-Notification-Service.git` |

To pull latest code inside every submodule:

```bash
git submodule foreach git pull origin main
```

For `web`, check its current branch before pulling because it may use a feature branch:

```bash
cd web
git branch --show-current
git pull
cd ..
```

## 4. Install Dependencies

From the repository root:

```bash
npm install
```

Install web dependencies if needed:

```bash
cd web
npm install
cd ..
```

The backend services are npm workspaces under the root project, but each service also has its own `package.json`.

## 5. Create Environment Files

Copy the root env example:

```bash
cp .env.example .env
```

Copy service env examples:

```bash
cp services/api-gateway/.env.example services/api-gateway/.env
cp services/auth-service/.env.example services/auth-service/.env
cp services/notification-service/.env.example services/notification-service/.env
```

Copy frontend env example:

```bash
cp web/.env.example web/.env
```

On Windows PowerShell, use:

```powershell
Copy-Item .env.example .env
Copy-Item services/api-gateway/.env.example services/api-gateway/.env
Copy-Item services/auth-service/.env.example services/auth-service/.env
Copy-Item services/notification-service/.env.example services/notification-service/.env
Copy-Item web/.env.example web/.env
```

## 6. Important Environment Values

For local browser development, these values must line up:

```env
# web/.env
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:5173

# services/api-gateway/.env
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
AUTH_SERVICE_URL=http://localhost:3001
NOTIFICATION_SERVICE_URL=http://localhost:3006
```

For auth-service:

```env
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=bin_auth
REDIS_HOST=localhost
REDIS_PORT=6379
KAFKA_BROKERS=localhost:9092
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=bin-ecommerce
FRONTEND_URL=http://localhost:5173
```

For notification-service:

```env
MONGODB_URI=mongodb://localhost:27017/bin_notification
KAFKA_BROKERS=localhost:9092
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@example.com
SMTP_PASSWORD=replace-with-app-password
```

## 7. Start Infrastructure

Start shared infrastructure from the root:

```bash
npm run infra:up
```

View infra logs:

```bash
npm run infra:logs
```

Stop infra:

```bash
npm run infra:down
```

## 8. Build Services

Build all backend workspaces:

```bash
npm run build
```

Build one service directly:

```bash
cd services/api-gateway
npm run build
```

```bash
cd services/auth-service
npm run build
```

```bash
cd services/notification-service
npm run build
```

## 9. Run Backend Services Locally

In separate terminals:

```bash
cd services/api-gateway
npm run dev
```

```bash
cd services/auth-service
npm run dev
```

```bash
cd services/notification-service
npm run dev
```

Default ports:

| Service              | Port   | Health Check                       |
| -------------------- | ------ | ---------------------------------- |
| API Gateway          | `3000` | `http://localhost:3000/api/health` |
| Auth Service         | `3001` | `http://localhost:3001/api/health` |
| Notification Service | `3006` | `http://localhost:3006/api/health` |
| Web                  | `5173` | `http://localhost:5173`            |

## 10. Run the Web App

```bash
cd web
npm run dev
```

Open:

```text
http://localhost:5173
```

The web app calls the API Gateway using:

```env
NEXT_PUBLIC_API_URL=http://localhost:3000
```

## 11. Docker Commands

Build service images:

```bash
npm run services:build
```

Start service containers:

```bash
npm run services:up
```

Stop service containers:

```bash
npm run services:down
```

## 12. Quick Smoke Tests

Check API Gateway:

```bash
curl http://localhost:3000/api/health
```

Check Auth Service:

```bash
curl http://localhost:3001/api/health
```

Check Notification Service:

```bash
curl http://localhost:3006/api/health
```

Test login through the gateway:

```bash
curl -i -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"user@example.com\",\"password\":\"Password1\"}"
```

## 13. Common Issues

### Submodule folder is empty

Run:

```bash
git submodule update --init --recursive
```

### CORS error from web to API Gateway

Make sure `services/api-gateway/.env` contains:

```env
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
```

Then restart API Gateway.

### Web type-check fails

Run:

```bash
cd web
npm run type-check
```

Fix the reported page/component export errors before treating the frontend as production-ready.

### Docker cannot connect to a service

Check whether you are using Docker network URLs or localhost URLs:

- Inside Docker Compose: `http://auth-service:3001`
- From host machine: `http://localhost:3001`

## 14. Recommended Development Order

1. Clone with submodules.
2. Copy `.env.example` files.
3. Start infra.
4. Start `auth-service`.
5. Start `notification-service`.
6. Start `api-gateway`.
7. Start `web`.
8. Test login/register through `http://localhost:5173`.
