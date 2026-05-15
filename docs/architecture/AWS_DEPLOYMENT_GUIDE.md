# AWS Deployment Guide - 1 EC2, Test/Prod, Auto CI/CD

Tài liệu này hướng dẫn deploy dự án Bin E-Commerce lên AWS bằng đúng cấu trúc hiện tại của repo, chỉ dùng **1 EC2**, nhưng vẫn tách rõ **test** và **prod**.

Mục tiêu:

- 1 EC2 chạy cả test và prod.
- Test tự deploy khi push nhánh `develop`.
- Prod tự deploy khi push nhánh `main`.
- Test và prod tách nhau bằng thư mục, env, Docker Compose project, container name, port và database name.
- Không cần Kubernetes, ECS, Load Balancer hay nhiều EC2 ở giai đoạn hiện tại.

## 1. Kiến trúc tổng quan

```text
GitHub
  |
  | push develop
  v
GitHub Actions
  |
  | SSH deploy
  v
EC2 /opt/bin-ecommerce/test
  +-- test-nginx              :8088 -> container :80
  +-- test-api-gateway        :13000 -> container :3000
  +-- test-auth-service       internal :3001
  +-- test-notification       internal :3006
  +-- test env                .env.test
  +-- test database           bin_auth_test
  +-- test Keycloak realm     bin-ecommerce-test

GitHub
  |
  | push main
  v
GitHub Actions
  |
  | SSH deploy
  v
EC2 /opt/bin-ecommerce/prod
  +-- prod-nginx              :80/:443 -> container :80/:443
  +-- prod-api-gateway        :3000 -> container :3000
  +-- prod-auth-service       internal :3001
  +-- prod-notification       internal :3006
  +-- prod env                .env.prod
  +-- prod database           bin_auth_prod
  +-- prod Keycloak realm     bin-ecommerce-prod

Shared infra on the same EC2
  +-- bin_postgres            :5432, Docker network only for app use
  +-- bin_mongodb             :27017, Docker network only for app use
  +-- bin_redis               :6379, Docker network only for app use
  +-- bin_kafka               :9092
  +-- bin_keycloak            :8080
  +-- bin_prometheus          :9090
  +-- bin_grafana             :3030
```

## 2. Vì sao tách test/prod theo cách này?

Repo hiện tại có `docker-compose.yml` và `infra/docker/docker-compose.infra.yml`.

`infra/docker/docker-compose.infra.yml` có `container_name` cố định như:

- `bin_postgres`
- `bin_mongodb`
- `bin_redis`
- `bin_kafka`
- `bin_keycloak`

Vì vậy trên 1 EC2, cách ít tốn RAM nhất là chỉ chạy **một cụm infra dùng chung**, rồi tách test/prod ở tầng app:

- Test và prod dùng chung PostgreSQL container nhưng khác database.
- Test và prod dùng chung Keycloak container nhưng khác realm.
- Test và prod dùng chung Kafka container nhưng nên khác consumer group/topic prefix khi code hỗ trợ.
- Test và prod có container app riêng.
- Test và prod dùng port public khác nhau.

Với cấu trúc hiện tại, guide này deploy 3 service backend đang có source code rõ trong repo:

- `api-gateway`
- `auth-service`
- `notification-service`
- `nginx`

Trong `docker-compose.yml`, `notification-service` đang nằm trong block mẫu bị comment, nên guide sẽ khai báo đầy đủ service này trong file override test/prod. Các service khác như product, cart, order, inventory, shipping, promotion, return đang có block mẫu nhưng nhiều block đang comment. Khi bật thêm service, cần thêm override container name/port/env tương ứng cho cả test và prod.

## 3. Quy ước môi trường

| Thành phần     | Test                             | Prod                            |
| -------------- | -------------------------------- | ------------------------------- |
| Branch         | `develop`                        | `main`                          |
| Folder EC2     | `/opt/bin-ecommerce/test`        | `/opt/bin-ecommerce/prod`       |
| Env file chính | `.env.test`                      | `.env.prod`                     |
| Docker project | `bin_test`                       | `bin_prod`                      |
| Nginx public   | `http://EC2_IP:8088`             | `http://EC2_IP`                 |
| API direct     | `http://EC2_IP:13000/api/health` | `http://EC2_IP:3000/api/health` |
| API via Nginx  | `http://EC2_IP:8088/api/health`  | `http://EC2_IP/api/health`      |
| Auth DB        | `bin_auth_test`                  | `bin_auth_prod`                 |
| Keycloak realm | `bin-ecommerce-test`             | `bin-ecommerce-prod`            |
| Frontend       | Vercel preview/test              | Vercel production               |

Nếu có domain:

| Domain                          | Trỏ tới                  |
| ------------------------------- | ------------------------ |
| `api.your-domain.com`           | EC2 port 80/443 cho prod |
| `test-api.your-domain.com:8088` | EC2 port 8088 cho test   |

Muốn test cũng dùng port 80/443 bằng subdomain riêng thì nên thêm một reverse proxy edge ở ngoài cùng. Guide này ưu tiên cách dễ triển khai nhất trên 1 EC2.

## 4. Chuẩn bị AWS EC2

### 4.1. Tạo EC2

Vào AWS Console:

1. EC2.
2. Launch instance.
3. Name: `bin-ecommerce-1ec2`.
4. AMI: Amazon Linux 2023.
5. Instance type:
   - Tối thiểu demo: `t3.small`.
   - Khuyến nghị: `t3.medium` nếu chạy Kafka, Keycloak, Prometheus, Grafana cùng lúc.
6. Storage:
   - Tối thiểu 40 GB.
   - Khuyến nghị 60 GB nếu build Docker nhiều lần.
7. Key pair:
   - Tạo key pair mới nếu chưa có.
   - Tải file `.pem`.
8. Public IP: Enable.
9. Security Group: tạo theo phần 4.2.

### 4.2. Security Group

Inbound rules:

| Port    | Source                   | Mục đích                |
| ------- | ------------------------ | ----------------------- |
| `22`    | Your IP only             | SSH                     |
| `80`    | `0.0.0.0/0`              | Prod API HTTP           |
| `443`   | `0.0.0.0/0`              | Prod API HTTPS          |
| `8088`  | Your IP hoặc `0.0.0.0/0` | Test API HTTP           |
| `8443`  | Your IP hoặc `0.0.0.0/0` | Test API HTTPS nếu dùng |
| `3000`  | Your IP only             | Debug prod API direct   |
| `13000` | Your IP only             | Debug test API direct   |
| `8080`  | Your IP only             | Keycloak admin          |
| `3030`  | Your IP only             | Grafana                 |
| `9090`  | Your IP only             | Prometheus              |

Không mở public:

- `5432` PostgreSQL
- `27017` MongoDB
- `6379` Redis
- `9092`, `29092` Kafka
- `3001` Auth service
- `3006` Notification service
- Các service nội bộ khác

### 4.3. Gắn Elastic IP

Nên gắn Elastic IP để IP không đổi:

1. EC2 Console.
2. Elastic IPs.
3. Allocate Elastic IP.
4. Associate Elastic IP với instance `bin-ecommerce-1ec2`.

## 5. SSH vào EC2

Trên Windows PowerShell:

```powershell
cd $HOME\Downloads
ssh -i .\your-key.pem ec2-user@YOUR_EC2_PUBLIC_IP
```

Nếu Windows báo lỗi permission:

```powershell
icacls .\your-key.pem /inheritance:r
icacls .\your-key.pem /grant:r "$env:USERNAME:R"
ssh -i .\your-key.pem ec2-user@YOUR_EC2_PUBLIC_IP
```

Update hệ điều hành:

```bash
sudo dnf update -y
```

## 6. Cài Docker, Git, Node.js

### 6.1. Cài Docker và Git

```bash
sudo dnf install -y docker git
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ec2-user
```

Đăng xuất rồi đăng nhập lại:

```bash
exit
ssh -i your-key.pem ec2-user@YOUR_EC2_PUBLIC_IP
```

Kiểm tra:

```bash
docker version
docker compose version
docker info
```

### 6.2. Cài Node.js 20+

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
node -v
npm -v
```

Repo yêu cầu:

```text
node >= 20
npm >= 10
```

## 7. Tạo swap cho EC2

Nếu EC2 ít RAM, tạo swap 4 GB:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

Nếu dùng `t3.small`, 4 GB swap là ổn cho demo. Nếu dùng `t3.micro`, có thể vẫn bị chậm khi chạy Kafka + Keycloak + build Docker.

### 7.1. Cấu hình 1 EC2 như vậy có ổn không?

Ổn nếu mục tiêu là demo, test nội bộ, portfolio hoặc MVP ít traffic. Không nên xem đây là cấu hình production lớn.

Khuyến nghị instance:

| Instance    | Đánh giá                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `t3.micro`  | Không khuyến nghị chạy cả test và prod. Dễ thiếu RAM vì Kafka + Keycloak + MongoDB + PostgreSQL + 2 bộ app. |
| `t3.small`  | Chạy được demo nếu traffic thấp, có swap 4-6 GB, và không build/deploy test-prod cùng lúc quá thường xuyên. |
| `t3.medium` | Khuyến nghị tối thiểu nếu muốn bật test và prod đồng thời ổn định hơn.                                      |
| `t3.large`  | Thoải mái hơn nếu bật thêm product/cart/order/inventory hoặc Prometheus/Grafana liên tục.                   |

Khuyến nghị disk:

- Tối thiểu 40 GB.
- Nên dùng 60 GB nếu build Docker trên EC2.
- Dọn Docker định kỳ bằng `docker system prune` sau khi kiểm tra không còn image/container cần rollback.

Điểm nghẽn chính:

- RAM: Keycloak, Kafka và MongoDB sẽ ăn RAM nền.
- CPU: mỗi lần `docker compose build` sẽ làm EC2 spike CPU.
- Disk: Docker image build nhiều lần làm đầy ổ rất nhanh.
- Network/security: test và prod dùng chung EC2, nên phải tách port, env, database và realm thật cẩn thận.

Kết luận thực tế:

- Đồ án/portfolio: 1 EC2 `t3.small` hoặc `t3.medium` là hợp lý.
- Demo cho nhà tuyển dụng: `t3.medium`, 60 GB disk, 4-8 GB swap là đẹp.
- Production thật có người dùng: nên tách database ra RDS/MongoDB Atlas, sau đó tách test/prod thành 2 EC2 hoặc dùng ECS.

## 8. Tạo cấu trúc thư mục trên EC2

```bash
sudo mkdir -p /opt/bin-ecommerce/test
sudo mkdir -p /opt/bin-ecommerce/prod
sudo mkdir -p /opt/bin-ecommerce/backups
sudo chown -R ec2-user:ec2-user /opt/bin-ecommerce
```

Cấu trúc sau khi xong:

```text
/opt/bin-ecommerce
  +-- test
  +-- prod
  +-- backups
```

## 9. Clone source cho test và prod

### 9.1. Clone test từ `develop`

```bash
cd /opt/bin-ecommerce/test
git clone --recurse-submodules -b develop https://github.com/Bin-E-Commerce/Bin-Ecommerce.git .
git submodule update --init --recursive
```

Nếu repo chưa có nhánh `develop`, tạo từ local rồi push:

```bash
git checkout -b develop
git push -u origin develop
```

### 9.2. Clone prod từ `main`

```bash
cd /opt/bin-ecommerce/prod
git clone --recurse-submodules -b main https://github.com/Bin-E-Commerce/Bin-Ecommerce.git .
git submodule update --init --recursive
```

Kiểm tra:

```bash
cd /opt/bin-ecommerce/test
git status
git branch --show-current
git submodule status

cd /opt/bin-ecommerce/prod
git status
git branch --show-current
git submodule status
```

## 10. Tạo override Docker Compose cho test/prod

Vì `docker-compose.yml` hiện có `container_name` và port cố định, nếu chạy test và prod cùng lúc sẽ bị đụng tên container/port.

Ta tạo file override riêng cho từng môi trường.

### 10.1. Override cho test

Tạo file:

```bash
cd /opt/bin-ecommerce/test
mkdir -p deploy
nano deploy/docker-compose.test.override.yml
```

Nội dung:

```yaml
services:
  api-gateway:
    container_name: test-api-gateway
    ports:
      - "13000:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      KEYCLOAK_REALM: bin-ecommerce-test
      AUTH_SERVICE_URL: http://auth-service:3001
      NOTIFICATION_SERVICE_URL: http://notification-service:3006
      ALLOWED_ORIGINS: ${ALLOWED_ORIGINS}

  auth-service:
    container_name: test-auth-service
    environment:
      NODE_ENV: production
      PORT: 3001
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_DB: bin_auth_test
      KEYCLOAK_REALM: bin-ecommerce-test
      KEYCLOAK_URL: http://keycloak:8080
      KAFKA_BROKERS: kafka:9092

  notification-service:
    build:
      context: .
      dockerfile: services/notification-service/Dockerfile
    image: bin-ecommerce/notification-service:test
    container_name: test-notification-service
    restart: unless-stopped
    env_file: .env
    networks:
      - bin_infra_net
      - bin_app_net
    environment:
      NODE_ENV: production
      PORT: 3006
      MONGODB_URI: mongodb://root:${MONGO_ROOT_PASSWORD}@mongodb:27017/bin_notification_test?authSource=admin
      KAFKA_BROKERS: kafka:9092
      SMTP_HOST: ${SMTP_HOST}
      SMTP_PORT: ${SMTP_PORT}
      SMTP_USER: ${SMTP_USER}
      SMTP_PASSWORD: ${SMTP_PASSWORD}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3006/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  nginx:
    container_name: test-nginx
    ports:
      - "8088:80"
      - "8443:443"
```

### 10.2. Override cho prod

Tạo file:

```bash
cd /opt/bin-ecommerce/prod
mkdir -p deploy
nano deploy/docker-compose.prod.override.yml
```

Nội dung:

```yaml
services:
  api-gateway:
    container_name: prod-api-gateway
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      KEYCLOAK_REALM: bin-ecommerce-prod
      AUTH_SERVICE_URL: http://auth-service:3001
      NOTIFICATION_SERVICE_URL: http://notification-service:3006
      ALLOWED_ORIGINS: ${ALLOWED_ORIGINS}

  auth-service:
    container_name: prod-auth-service
    environment:
      NODE_ENV: production
      PORT: 3001
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_DB: bin_auth_prod
      KEYCLOAK_REALM: bin-ecommerce-prod
      KEYCLOAK_URL: http://keycloak:8080
      KAFKA_BROKERS: kafka:9092

  notification-service:
    build:
      context: .
      dockerfile: services/notification-service/Dockerfile
    image: bin-ecommerce/notification-service:prod
    container_name: prod-notification-service
    restart: unless-stopped
    env_file: .env
    networks:
      - bin_infra_net
      - bin_app_net
    environment:
      NODE_ENV: production
      PORT: 3006
      MONGODB_URI: mongodb://root:${MONGO_ROOT_PASSWORD}@mongodb:27017/bin_notification_prod?authSource=admin
      KAFKA_BROKERS: kafka:9092
      SMTP_HOST: ${SMTP_HOST}
      SMTP_PORT: ${SMTP_PORT}
      SMTP_USER: ${SMTP_USER}
      SMTP_PASSWORD: ${SMTP_PASSWORD}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3006/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  nginx:
    container_name: prod-nginx
    ports:
      - "80:80"
      - "443:443"
```

## 11. Tạo env cho test/prod

### 11.1. Env test

```bash
cd /opt/bin-ecommerce/test
cp .env.example .env.test
nano .env.test
```

Ví dụ:

```env
NODE_ENV=production

POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=bin_ecommerce
POSTGRES_PASSWORD=CHANGE_ME_POSTGRES_PASSWORD
POSTGRES_DB=bin_ecommerce

MONGO_ROOT_USER=root
MONGO_ROOT_PASSWORD=CHANGE_ME_MONGO_PASSWORD
MONGODB_URI=mongodb://root:CHANGE_ME_MONGO_PASSWORD@mongodb:27017/bin_ecommerce_test?authSource=admin

REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=1

KAFKA_BROKERS=kafka:9092
KAFKA_CLIENT_ID=bin-ecommerce-test
KAFKA_GROUP_ID_PREFIX=bin-ecommerce-test

KEYCLOAK_URL=http://keycloak:8080
KEYCLOAK_REALM=bin-ecommerce-test
KEYCLOAK_CLIENT_ID=api-gateway
KEYCLOAK_CLIENT_SECRET=CHANGE_ME_TEST_CLIENT_SECRET
KEYCLOAK_ADMIN_CLIENT_ID=admin-cli
KEYCLOAK_ADMIN_CLIENT_SECRET=CHANGE_ME_TEST_ADMIN_CLIENT_SECRET
KEYCLOAK_WEB_CLIENT_ID=web-client
KEYCLOAK_ADMIN_USER=admin
KEYCLOAK_ADMIN_PASSWORD=CHANGE_ME_KEYCLOAK_ADMIN_PASSWORD

FRONTEND_URL=https://test-your-web-domain.vercel.app
ALLOWED_ORIGINS=https://test-your-web-domain.vercel.app,http://localhost:5173

AUTH_SERVICE_URL=http://auth-service:3001
PRODUCT_SERVICE_URL=http://product-service:3002
CART_SERVICE_URL=http://cart-service:3003
ORDER_SERVICE_URL=http://order-service:3004
INVENTORY_SERVICE_URL=http://inventory-service:3005
NOTIFICATION_SERVICE_URL=http://notification-service:3006
SHIPPING_SERVICE_URL=http://shipping-service:3007
PROMOTION_SERVICE_URL=http://promotion-service:3008
RETURN_SERVICE_URL=http://return-service:3009

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-test-email@example.com
SMTP_PASSWORD=CHANGE_ME_SMTP_APP_PASSWORD
SMTP_FROM=test-noreply@your-domain.com

GRAFANA_ADMIN_PASSWORD=CHANGE_ME_GRAFANA_PASSWORD
```

Sau đó:

```bash
cp .env.test .env
chmod 600 .env .env.test
```

### 11.2. Env prod

```bash
cd /opt/bin-ecommerce/prod
cp .env.example .env.prod
nano .env.prod
```

Ví dụ:

```env
NODE_ENV=production

POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=bin_ecommerce
POSTGRES_PASSWORD=CHANGE_ME_POSTGRES_PASSWORD
POSTGRES_DB=bin_ecommerce

MONGO_ROOT_USER=root
MONGO_ROOT_PASSWORD=CHANGE_ME_MONGO_PASSWORD
MONGODB_URI=mongodb://root:CHANGE_ME_MONGO_PASSWORD@mongodb:27017/bin_ecommerce_prod?authSource=admin

REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

KAFKA_BROKERS=kafka:9092
KAFKA_CLIENT_ID=bin-ecommerce-prod
KAFKA_GROUP_ID_PREFIX=bin-ecommerce-prod

KEYCLOAK_URL=http://keycloak:8080
KEYCLOAK_REALM=bin-ecommerce-prod
KEYCLOAK_CLIENT_ID=api-gateway
KEYCLOAK_CLIENT_SECRET=CHANGE_ME_PROD_CLIENT_SECRET
KEYCLOAK_ADMIN_CLIENT_ID=admin-cli
KEYCLOAK_ADMIN_CLIENT_SECRET=CHANGE_ME_PROD_ADMIN_CLIENT_SECRET
KEYCLOAK_WEB_CLIENT_ID=web-client
KEYCLOAK_ADMIN_USER=admin
KEYCLOAK_ADMIN_PASSWORD=CHANGE_ME_KEYCLOAK_ADMIN_PASSWORD

FRONTEND_URL=https://your-web-domain.com
ALLOWED_ORIGINS=https://your-web-domain.com,https://www.your-web-domain.com

AUTH_SERVICE_URL=http://auth-service:3001
PRODUCT_SERVICE_URL=http://product-service:3002
CART_SERVICE_URL=http://cart-service:3003
ORDER_SERVICE_URL=http://order-service:3004
INVENTORY_SERVICE_URL=http://inventory-service:3005
NOTIFICATION_SERVICE_URL=http://notification-service:3006
SHIPPING_SERVICE_URL=http://shipping-service:3007
PROMOTION_SERVICE_URL=http://promotion-service:3008
RETURN_SERVICE_URL=http://return-service:3009

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-prod-email@example.com
SMTP_PASSWORD=CHANGE_ME_SMTP_APP_PASSWORD
SMTP_FROM=noreply@your-domain.com

GRAFANA_ADMIN_PASSWORD=CHANGE_ME_GRAFANA_PASSWORD
```

Sau đó:

```bash
cp .env.prod .env
chmod 600 .env .env.prod
```

## 12. Chạy infra dùng chung

Chỉ chạy infra một lần. Dùng thư mục prod làm nơi quản lý infra:

```bash
cd /opt/bin-ecommerce/prod
cp .env.prod .env
docker compose -f infra/docker/docker-compose.infra.yml up -d
```

Kiểm tra:

```bash
docker compose -f infra/docker/docker-compose.infra.yml ps
docker logs bin_postgres --tail=100
docker logs bin_keycloak --tail=100
docker logs bin_kafka --tail=100
```

Đợi các container healthy:

```bash
docker ps
```

## 13. Tạo database riêng cho test/prod

Vì test và prod dùng chung PostgreSQL container, phải tách database.

Tạo database auth:

```bash
docker exec -it bin_postgres psql -U bin_ecommerce -d postgres -c "CREATE DATABASE bin_auth_test;"
docker exec -it bin_postgres psql -U bin_ecommerce -d postgres -c "CREATE DATABASE bin_auth_prod;"
```

Nếu user PostgreSQL khác `bin_ecommerce`, đổi lại theo `.env`.

Kiểm tra:

```bash
docker exec -it bin_postgres psql -U bin_ecommerce -d postgres -c "\l"
```

Nếu sau này bật thêm services:

```bash
docker exec -it bin_postgres psql -U bin_ecommerce -d postgres -c "CREATE DATABASE bin_product_test;"
docker exec -it bin_postgres psql -U bin_ecommerce -d postgres -c "CREATE DATABASE bin_product_prod;"
docker exec -it bin_postgres psql -U bin_ecommerce -d postgres -c "CREATE DATABASE bin_order_test;"
docker exec -it bin_postgres psql -U bin_ecommerce -d postgres -c "CREATE DATABASE bin_order_prod;"
docker exec -it bin_postgres psql -U bin_ecommerce -d postgres -c "CREATE DATABASE bin_inventory_test;"
docker exec -it bin_postgres psql -U bin_ecommerce -d postgres -c "CREATE DATABASE bin_inventory_prod;"
```

MongoDB không bắt buộc tạo DB trước. DB sẽ được tạo khi service ghi dữ liệu lần đầu, nhưng nên đặt tên tách biệt:

- `bin_ecommerce_test`
- `bin_ecommerce_prod`
- `bin_notification_test`
- `bin_notification_prod`

## 14. Tạo Keycloak realm test/prod

Mở Keycloak:

```text
http://YOUR_EC2_PUBLIC_IP:8080
```

Đăng nhập bằng:

```text
KEYCLOAK_ADMIN_USER
KEYCLOAK_ADMIN_PASSWORD
```

Tạo 2 realm:

```text
bin-ecommerce-test
bin-ecommerce-prod
```

Trong mỗi realm, tạo client backend:

```text
Client ID: api-gateway
Client authentication: On
Standard flow: On
Direct access grants: On nếu auth-service login bằng username/password
Service accounts: On nếu cần Admin API
```

Redirect URI test:

```text
https://test-your-web-domain.vercel.app/*
http://localhost:5173/*
```

Web origins test:

```text
https://test-your-web-domain.vercel.app
http://localhost:5173
```

Redirect URI prod:

```text
https://your-web-domain.com/*
https://www.your-web-domain.com/*
```

Web origins prod:

```text
https://your-web-domain.com
https://www.your-web-domain.com
```

Copy client secret tương ứng vào:

- `/opt/bin-ecommerce/test/.env.test`
- `/opt/bin-ecommerce/prod/.env.prod`

Tạo client frontend trong mỗi realm:

```text
Client ID: web-client
Client authentication: Off
Standard flow: On
```

Tạo role nếu code cần:

```text
USER
ADMIN
```

## 15. Deploy test thủ công lần đầu

```bash
cd /opt/bin-ecommerce/test
git checkout develop
git pull origin develop
git submodule update --init --recursive
cp .env.test .env

docker compose \
  -p bin_test \
  -f docker-compose.yml \
  -f deploy/docker-compose.test.override.yml \
  build

docker compose \
  -p bin_test \
  -f docker-compose.yml \
  -f deploy/docker-compose.test.override.yml \
  up -d
```

Kiểm tra:

```bash
docker compose -p bin_test -f docker-compose.yml -f deploy/docker-compose.test.override.yml ps
docker logs test-api-gateway --tail=100
docker logs test-auth-service --tail=100
docker logs test-notification-service --tail=100
docker logs test-nginx --tail=100
```

Health:

```bash
curl http://localhost:13000/api/health
curl http://localhost:8088/api/health
curl http://YOUR_EC2_PUBLIC_IP:8088/api/health
docker exec test-notification-service wget -qO- http://localhost:3006/api/health
```

## 16. Deploy prod thủ công lần đầu

```bash
cd /opt/bin-ecommerce/prod
git checkout main
git pull origin main
git submodule update --init --recursive
cp .env.prod .env

docker compose \
  -p bin_prod \
  -f docker-compose.yml \
  -f deploy/docker-compose.prod.override.yml \
  build

docker compose \
  -p bin_prod \
  -f docker-compose.yml \
  -f deploy/docker-compose.prod.override.yml \
  up -d
```

Kiểm tra:

```bash
docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml ps
docker logs prod-api-gateway --tail=100
docker logs prod-auth-service --tail=100
docker logs prod-notification-service --tail=100
docker logs prod-nginx --tail=100
```

Health:

```bash
curl http://localhost:3000/api/health
curl http://localhost/api/health
curl http://YOUR_EC2_PUBLIC_IP/api/health
docker exec prod-notification-service wget -qO- http://localhost:3006/api/health
```

## 17. Lệnh quản lý môi trường

### 17.1. Xem test

```bash
cd /opt/bin-ecommerce/test
docker compose -p bin_test -f docker-compose.yml -f deploy/docker-compose.test.override.yml ps
```

### 17.2. Xem prod

```bash
cd /opt/bin-ecommerce/prod
docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml ps
```

### 17.3. Restart test

```bash
cd /opt/bin-ecommerce/test
docker compose -p bin_test -f docker-compose.yml -f deploy/docker-compose.test.override.yml restart
```

### 17.4. Restart prod

```bash
cd /opt/bin-ecommerce/prod
docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml restart
```

### 17.5. Stop test

```bash
cd /opt/bin-ecommerce/test
docker compose -p bin_test -f docker-compose.yml -f deploy/docker-compose.test.override.yml down
```

### 17.6. Stop prod

```bash
cd /opt/bin-ecommerce/prod
docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml down
```

Không dùng `down -v` nếu chưa backup, vì có thể xóa volume dữ liệu.

## 18. Deploy frontend Vercel

Frontend nằm trong submodule `web/`.

Nên dùng 2 môi trường Vercel:

| Vercel env   | Branch    | API URL                                               |
| ------------ | --------- | ----------------------------------------------------- |
| Preview/Test | `develop` | `http://YOUR_EC2_PUBLIC_IP:8088` hoặc test API domain |
| Production   | `main`    | `https://api.your-domain.com`                         |

Env test trên Vercel:

```env
NEXT_PUBLIC_API_URL=http://YOUR_EC2_PUBLIC_IP:8088
NEXT_PUBLIC_KEYCLOAK_URL=http://YOUR_EC2_PUBLIC_IP:8080
NEXT_PUBLIC_KEYCLOAK_REALM=bin-ecommerce-test
NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=web-client
NEXT_PUBLIC_APP_URL=https://test-your-web-domain.vercel.app
```

Env prod trên Vercel:

```env
NEXT_PUBLIC_API_URL=https://api.your-domain.com
NEXT_PUBLIC_KEYCLOAK_URL=https://auth.your-domain.com
NEXT_PUBLIC_KEYCLOAK_REALM=bin-ecommerce-prod
NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=web-client
NEXT_PUBLIC_APP_URL=https://your-web-domain.com
```

Nếu chưa có domain HTTPS cho Keycloak, có thể dùng `http://YOUR_EC2_PUBLIC_IP:8080` trong giai đoạn test, nhưng production thật nên expose Keycloak qua HTTPS.

## 19. Cấu hình GitHub Actions auto deploy

### 19.1. Tạo deploy SSH key

Trên máy local:

```bash
ssh-keygen -t ed25519 -C "bin-ecommerce-github-actions" -f ./bin-ecommerce-deploy
```

File tạo ra:

```text
bin-ecommerce-deploy
bin-ecommerce-deploy.pub
```

Copy public key:

```bash
cat ./bin-ecommerce-deploy.pub
```

Trên EC2:

```bash
mkdir -p ~/.ssh
nano ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

Paste nội dung `.pub` vào `authorized_keys`.

### 19.2. Tạo GitHub Secrets

Vào GitHub repo chính:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

Tạo secrets:

```text
EC2_HOST=YOUR_EC2_PUBLIC_IP_OR_DOMAIN
EC2_USER=ec2-user
EC2_SSH_KEY=private key content of bin-ecommerce-deploy
TEST_APP_DIR=/opt/bin-ecommerce/test
PROD_APP_DIR=/opt/bin-ecommerce/prod
```

Private key là nội dung file `bin-ecommerce-deploy`, không phải `.pub`.

### 19.3. Tạo GitHub Environments

Vào:

```text
Settings -> Environments
```

Tạo:

```text
test
production
```

Khuyến nghị:

- `test`: không cần approval.
- `production`: bật required reviewers để tránh deploy prod nhầm.

## 20. Workflow CI/CD tự động

Tạo file trong repo chính:

```text
.github/workflows/deploy-ec2.yml
```

Nội dung:

```yaml
name: Deploy Backend To EC2

on:
  push:
    branches:
      - develop
      - main
  workflow_dispatch:
    inputs:
      environment:
        description: "Environment to deploy"
        required: true
        default: "test"
        type: choice
        options:
          - test
          - production

concurrency:
  group: deploy-${{ github.ref_name }}-${{ inputs.environment || 'auto' }}
  cancel-in-progress: false

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          submodules: recursive

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build workspace
        run: npm run build

  deploy-test:
    needs: validate
    runs-on: ubuntu-latest
    environment: test
    if: >
      github.ref_name == 'develop' ||
      (github.event_name == 'workflow_dispatch' && inputs.environment == 'test')

    steps:
      - name: Prepare SSH key
        run: |
          mkdir -p ~/.ssh
          printf '%s\n' "${{ secrets.EC2_SSH_KEY }}" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          ssh-keyscan -H "${{ secrets.EC2_HOST }}" >> ~/.ssh/known_hosts

      - name: Deploy test
        run: |
          ssh -i ~/.ssh/deploy_key "${{ secrets.EC2_USER }}@${{ secrets.EC2_HOST }}" << 'EOF'
            set -e
            cd "${{ secrets.TEST_APP_DIR }}"
            git fetch origin develop
            git checkout develop
            git pull origin develop
            git submodule update --init --recursive
            cp .env.test .env
            docker compose -p bin_test -f docker-compose.yml -f deploy/docker-compose.test.override.yml build
            docker compose -p bin_test -f docker-compose.yml -f deploy/docker-compose.test.override.yml up -d
            docker compose -p bin_test -f docker-compose.yml -f deploy/docker-compose.test.override.yml ps
            curl -f http://localhost:13000/api/health
            curl -f http://localhost:8088/api/health
            docker exec test-notification-service wget -qO- http://localhost:3006/api/health
          EOF

  deploy-production:
    needs: validate
    runs-on: ubuntu-latest
    environment: production
    if: >
      github.ref_name == 'main' ||
      (github.event_name == 'workflow_dispatch' && inputs.environment == 'production')

    steps:
      - name: Prepare SSH key
        run: |
          mkdir -p ~/.ssh
          printf '%s\n' "${{ secrets.EC2_SSH_KEY }}" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          ssh-keyscan -H "${{ secrets.EC2_HOST }}" >> ~/.ssh/known_hosts

      - name: Deploy production
        run: |
          ssh -i ~/.ssh/deploy_key "${{ secrets.EC2_USER }}@${{ secrets.EC2_HOST }}" << 'EOF'
            set -e
            cd "${{ secrets.PROD_APP_DIR }}"
            git fetch origin main
            git checkout main
            git pull origin main
            git submodule update --init --recursive
            cp .env.prod .env
            docker compose -f infra/docker/docker-compose.infra.yml up -d
            docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml build
            docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml up -d
            docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml ps
            curl -f http://localhost:3000/api/health
            curl -f http://localhost/api/health
            docker exec prod-notification-service wget -qO- http://localhost:3006/api/health
          EOF
```

Luồng hoạt động:

- Push `develop`:
  - GitHub Actions build toàn repo.
  - Nếu build pass, SSH vào EC2.
  - Pull code ở `/opt/bin-ecommerce/test`.
  - Build và restart stack `bin_test`.
  - Health check test.

- Push `main`:
  - GitHub Actions build toàn repo.
  - Nếu build pass, SSH vào EC2.
  - Pull code ở `/opt/bin-ecommerce/prod`.
  - Đảm bảo infra đang chạy.
  - Build và restart stack `bin_prod`.
  - Health check prod.

- Manual deploy:
  - Vào Actions.
  - Chọn `Deploy Backend To EC2`.
  - Run workflow.
  - Chọn `test` hoặc `production`.

## 21. Deploy submodule trong CI/CD

Repo này có submodule:

- `web`
- `services/api-gateway`
- `services/auth-service`
- `services/notification-service`

Workflow đã dùng:

```yaml
with:
  submodules: recursive
```

Trên EC2 cũng có:

```bash
git submodule update --init --recursive
```

Nếu submodule private, EC2 và GitHub Actions phải có quyền đọc từng repo submodule. Nếu không, deploy sẽ lỗi ở bước update submodule.

## 22. Domain và HTTPS cho prod

### 22.1. Trỏ domain prod

Tạo DNS A record:

```text
api.your-domain.com -> YOUR_EC2_ELASTIC_IP
```

Test:

```bash
nslookup api.your-domain.com
curl http://api.your-domain.com/api/health
```

### 22.2. HTTPS bằng Certbot

Tạm dừng prod Nginx nếu cần port 80:

```bash
docker stop prod-nginx
```

Cấp cert:

```bash
python3 -m pip install --user certbot
export PATH=$PATH:$HOME/.local/bin
certbot certonly --standalone -d api.your-domain.com
```

Copy cert vào thư mục Nginx:

```bash
cd /opt/bin-ecommerce/prod
mkdir -p infra/nginx/ssl/api.your-domain.com
sudo cp /etc/letsencrypt/live/api.your-domain.com/fullchain.pem infra/nginx/ssl/api.your-domain.com/fullchain.pem
sudo cp /etc/letsencrypt/live/api.your-domain.com/privkey.pem infra/nginx/ssl/api.your-domain.com/privkey.pem
sudo chown -R ec2-user:ec2-user infra/nginx/ssl
```

Sửa `infra/nginx/conf.d/default.conf` cho prod HTTPS:

```nginx
upstream api_gateway {
    server api-gateway:3000;
    keepalive 32;
}

server {
    listen 80;
    server_name api.your-domain.com;

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name api.your-domain.com;

    ssl_certificate /etc/nginx/ssl/api.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/api.your-domain.com/privkey.pem;

    location /api/ {
        proxy_pass http://api_gateway;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 60s;
        proxy_buffering off;
    }
}
```

Restart:

```bash
docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml up -d nginx
docker exec prod-nginx nginx -t
curl https://api.your-domain.com/api/health
```

## 23. Backup dữ liệu

Tạo thư mục:

```bash
mkdir -p /opt/bin-ecommerce/backups/postgres
mkdir -p /opt/bin-ecommerce/backups/mongodb
```

Backup PostgreSQL:

```bash
docker exec bin_postgres pg_dumpall -U bin_ecommerce > /opt/bin-ecommerce/backups/postgres/all-$(date +%F-%H%M).sql
```

Backup MongoDB:

```bash
docker exec bin_mongodb mongodump \
  --username root \
  --password CHANGE_ME_MONGO_PASSWORD \
  --authenticationDatabase admin \
  --archive > /opt/bin-ecommerce/backups/mongodb/mongo-$(date +%F-%H%M).archive
```

Cron backup mỗi ngày 2 giờ sáng:

```bash
crontab -e
```

Thêm:

```cron
0 2 * * * docker exec bin_postgres pg_dumpall -U bin_ecommerce > /opt/bin-ecommerce/backups/postgres/all-$(date +\%F-\%H\%M).sql
```

Tải backup về máy local:

```powershell
scp -i .\your-key.pem ec2-user@YOUR_EC2_PUBLIC_IP:/opt/bin-ecommerce/backups/postgres/all-YYYY-MM-DD-HHMM.sql .
```

## 24. Rollback

### 24.1. Rollback test

```bash
cd /opt/bin-ecommerce/test
git log --oneline -n 10
git checkout COMMIT_SHA
git submodule update --init --recursive
cp .env.test .env
docker compose -p bin_test -f docker-compose.yml -f deploy/docker-compose.test.override.yml build
docker compose -p bin_test -f docker-compose.yml -f deploy/docker-compose.test.override.yml up -d
curl http://localhost:13000/api/health
```

Quay lại `develop`:

```bash
git checkout develop
git pull origin develop
git submodule update --init --recursive
```

### 24.2. Rollback prod

```bash
cd /opt/bin-ecommerce/prod
git log --oneline -n 10
git checkout COMMIT_SHA
git submodule update --init --recursive
cp .env.prod .env
docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml build
docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml up -d
curl http://localhost:3000/api/health
```

Quay lại `main`:

```bash
git checkout main
git pull origin main
git submodule update --init --recursive
```

## 25. Debug thường gặp

### 25.1. Container name conflict

Lỗi:

```text
Conflict. The container name "/api-gateway" is already in use
```

Nguyên nhân:

- Chạy test/prod cùng lúc nhưng chưa dùng override `container_name`.

Cách xử lý:

```bash
docker ps -a
```

Đảm bảo test dùng:

```text
test-api-gateway
test-auth-service
test-notification-service
test-nginx
```

Prod dùng:

```text
prod-api-gateway
prod-auth-service
prod-notification-service
prod-nginx
```

### 25.2. Port conflict

Lỗi:

```text
Bind for 0.0.0.0:80 failed: port is already allocated
```

Nguyên nhân:

- Test và prod cùng bind port 80.

Cách xử lý:

- Prod dùng `80:80`, `443:443`.
- Test dùng `8088:80`, `8443:443`.

### 25.3. API Gateway không gọi được Auth Service

Kiểm tra trong container:

```bash
docker exec -it test-api-gateway wget -qO- http://auth-service:3001/api/health
docker exec -it prod-api-gateway wget -qO- http://auth-service:3001/api/health
docker exec -it test-api-gateway wget -qO- http://notification-service:3006/api/health
docker exec -it prod-api-gateway wget -qO- http://notification-service:3006/api/health
```

`AUTH_SERVICE_URL` phải là:

```env
AUTH_SERVICE_URL=http://auth-service:3001
```

Không dùng `localhost` trong Docker container.

### 25.4. CORS lỗi

Kiểm tra `.env.test` và `.env.prod`:

```env
ALLOWED_ORIGINS=https://your-web-domain.com
```

Nhiều origin thì dùng dấu phẩy:

```env
ALLOWED_ORIGINS=https://your-web-domain.com,https://www.your-web-domain.com
```

Restart:

```bash
docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml up -d --force-recreate api-gateway
```

### 25.5. Keycloak realm sai

Test phải dùng:

```env
KEYCLOAK_REALM=bin-ecommerce-test
```

Prod phải dùng:

```env
KEYCLOAK_REALM=bin-ecommerce-prod
```

Nếu frontend test login vào realm prod, token issuer sẽ không khớp.

### 25.6. GitHub Actions không SSH được

Kiểm tra:

- `EC2_HOST` đúng IP/domain.
- Security Group mở port 22 cho GitHub Actions IP hoặc tạm mở rộng hơn khi test.
- `EC2_SSH_KEY` là private key, không phải public key.
- Public key đã nằm trong `~/.ssh/authorized_keys` trên EC2.

Test từ máy local:

```bash
ssh -i ./bin-ecommerce-deploy ec2-user@YOUR_EC2_PUBLIC_IP
```

### 25.7. EC2 hết RAM

Kiểm tra:

```bash
free -h
docker stats
```

Cách xử lý:

- Tăng swap.
- Tắt Prometheus/Grafana khi chưa cần.
- Tắt test khi không dùng.
- Nâng EC2 lên `t3.medium`.

## 26. Checklist hoàn tất

Infra:

```bash
docker ps | grep bin_postgres
docker ps | grep bin_keycloak
docker ps | grep bin_kafka
```

Test:

```bash
curl http://localhost:13000/api/health
curl http://localhost:8088/api/health
curl http://YOUR_EC2_PUBLIC_IP:8088/api/health
docker exec test-notification-service wget -qO- http://localhost:3006/api/health
```

Prod:

```bash
curl http://localhost:3000/api/health
curl http://localhost/api/health
curl http://YOUR_EC2_PUBLIC_IP/api/health
docker exec prod-notification-service wget -qO- http://localhost:3006/api/health
```

GitHub Actions:

- Push `develop` deploy test thành công.
- Push `main` deploy prod thành công.
- Production environment có reviewer nếu muốn chống deploy nhầm.

Frontend:

- Vercel test dùng realm `bin-ecommerce-test`.
- Vercel prod dùng realm `bin-ecommerce-prod`.
- `NEXT_PUBLIC_API_URL` trỏ đúng API của từng môi trường.

## 27. Lệnh nhanh

Deploy test:

```bash
cd /opt/bin-ecommerce/test
git pull origin develop
git submodule update --init --recursive
cp .env.test .env
docker compose -p bin_test -f docker-compose.yml -f deploy/docker-compose.test.override.yml build
docker compose -p bin_test -f docker-compose.yml -f deploy/docker-compose.test.override.yml up -d
curl http://localhost:13000/api/health
```

Deploy prod:

```bash
cd /opt/bin-ecommerce/prod
git pull origin main
git submodule update --init --recursive
cp .env.prod .env
docker compose -f infra/docker/docker-compose.infra.yml up -d
docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml build
docker compose -p bin_prod -f docker-compose.yml -f deploy/docker-compose.prod.override.yml up -d
curl http://localhost:3000/api/health
```

Xem log test:

```bash
docker logs -f test-api-gateway
docker logs -f test-auth-service
docker logs -f test-notification-service
docker logs -f test-nginx
```

Xem log prod:

```bash
docker logs -f prod-api-gateway
docker logs -f prod-auth-service
docker logs -f prod-notification-service
docker logs -f prod-nginx
```

## 28. Nguồn tham khảo chính thức

- AWS Docker trên Amazon Linux/EC2: https://docs.aws.amazon.com/AmazonECR/latest/public/getting-started-cli.html
- AWS Security Group ingress rules: https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-ec2-securitygroup-ingress.html
- GitHub Actions deployments: https://docs.github.com/actions/deployment/deploying-with-github-actions
- GitHub Actions secrets: https://docs.github.com/actions/reference/encrypted-secrets
