# AWS Deployment Guide - Bin E-Commerce

Tài liệu này hướng dẫn deploy dự án Bin E-Commerce lên AWS theo cấu trúc hiện tại của repository:

- Frontend: `web/` là Next.js, nên deploy lên Vercel là hướng gọn nhất.
- Backend: `services/api-gateway`, `services/auth-service`, `services/notification-service` chạy bằng Docker Compose.
- Infra hiện có: PostgreSQL, MongoDB, Redis, Kafka KRaft, Keycloak, Prometheus, Grafana trong `infra/docker/docker-compose.infra.yml`.
- Reverse proxy: Nginx trong `docker-compose.yml`, cấu hình tại `infra/nginx/conf.d/default.conf`.

> Lưu ý quan trọng: trong `docker-compose.yml` hiện tại mới bật trực tiếp `api-gateway`, `auth-service` và `nginx`. Các service domain như product, cart, order, inventory, shipping, promotion, return, notification đang có block mẫu nhưng nhiều block đang comment. Khi muốn deploy đầy đủ, phải mở comment từng service và đảm bảo source code/Dockerfile/env tương ứng đã tồn tại.

## 1. Kiến trúc deploy khuyến nghị

### 1.1. Bản tiết kiệm, dễ làm nhất

```text
User
  |
  | HTTPS
  v
Vercel - Next.js web
  |
  | NEXT_PUBLIC_API_URL=https://api.your-domain.com
  v
AWS EC2 - Docker Compose
  |
  +-- nginx :80/:443
  +-- api-gateway :3000
  +-- auth-service :3001
  +-- notification-service :3006
  +-- postgres :5432
  +-- mongodb :27017
  +-- redis :6379
  +-- kafka :9092
  +-- keycloak :8080
  +-- prometheus :9090
  +-- grafana :3030
```

Ưu điểm:

- Dễ triển khai, phù hợp demo, đồ án, portfolio, phỏng vấn.
- Dùng đúng Docker Compose hiện có.
- Không cần Kubernetes/ECS ngay từ đầu.

Nhược điểm:

- Một EC2 chứa cả app và infra nên tài nguyên hạn chế.
- Database nằm trong Docker volume trên EC2, cần backup kỹ.
- Không phù hợp production traffic lớn.

### 1.2. Bản gần production hơn

```text
Vercel
  |
  v
EC2-A App Server
  +-- nginx
  +-- api-gateway
  +-- auth-service
  +-- notification-service

EC2-B Infra Server
  +-- kafka
  +-- keycloak
  +-- prometheus
  +-- grafana

Managed services
  +-- AWS RDS PostgreSQL
  +-- MongoDB Atlas
  +-- Redis managed/self-hosted
  +-- SMTP/SendGrid
```

Ưu điểm:

- App và infra tách nhau.
- Database managed giúp giảm rủi ro mất dữ liệu.
- Dễ scale hơn.

Nhược điểm:

- Nhiều bước cấu hình hơn.
- Cần quản lý network/security group chặt hơn.

Guide này đi theo bản tiết kiệm trước, sau đó có phần nâng cấp lên bản gần production.

## 2. Checklist trước khi deploy

### 2.1. Kiểm tra code local

Ở máy local:

```bash
git status
git submodule status
npm install
npm run build
```

Nếu chỉ muốn kiểm tra từng service:

```bash
cd services/api-gateway
npm install
npm run build

cd ../auth-service
npm install
npm run build

cd ../notification-service
npm install
npm run build
```

### 2.2. Kiểm tra Docker local

Từ root repo:

```bash
copy .env.example .env
npm run infra:up
npm run services:build
npm run services:up
```

Kiểm tra container:

```bash
docker ps
docker compose ps
docker compose -f infra/docker/docker-compose.infra.yml ps
```

Kiểm tra health:

```bash
curl http://localhost:3000/api/health
curl http://localhost:3001/api/health
curl http://localhost:3006/api/health
```

### 2.3. Lưu ý về Nginx hiện tại

File `infra/nginx/conf.d/default.conf` hiện đang có nhiều comment kiểu `//`. Nginx chuẩn dùng `#` cho comment, không dùng `//`.

Trước khi deploy thật, hãy kiểm tra:

```bash
docker compose up -d nginx
docker logs nginx
docker exec nginx nginx -t
```

Nếu thấy lỗi syntax do `//`, cần sửa các comment `// ...` thành `# ...`.

Ngoài ra, app có global prefix `api`, nên health endpoint thật của API Gateway là:

```text
/api/health
```

Nếu muốn Nginx expose `/health`, cần rewrite/proxy đúng về `/api/health`, hoặc đơn giản dùng `/api/health` làm endpoint public.

## 3. Chuẩn bị AWS

### 3.1. Tạo EC2 instance

Vào AWS Console:

1. Mở EC2.
2. Chọn Launch instance.
3. Name: `bin-ecommerce-prod`.
4. AMI: Amazon Linux 2023.
5. Instance type:
   - Demo tiết kiệm: `t3.micro` hoặc `t3.small`.
   - Dễ thở hơn: `t3.medium`.
6. Key pair:
   - Tạo key mới nếu chưa có.
   - Tải file `.pem` về máy.
7. Storage:
   - Tối thiểu 30 GB.
   - Khuyến nghị 40-60 GB nếu chạy Kafka, Keycloak, database local.
8. Network:
   - Auto-assign public IP: Enable.
9. Security group: tạo mới theo phần bên dưới.

### 3.2. Security group cho bản single EC2

Inbound rules khuyến nghị:

| Type | Port | Source | Mục đích |
| --- | --- | --- | --- |
| SSH | 22 | Your IP only | SSH vào server |
| HTTP | 80 | 0.0.0.0/0 | Public API qua Nginx |
| HTTPS | 443 | 0.0.0.0/0 | Public API HTTPS |
| Custom TCP | 3000 | Your IP only | Test API Gateway tạm thời |
| Custom TCP | 8080 | Your IP only | Keycloak admin tạm thời |
| Custom TCP | 3030 | Your IP only | Grafana admin tạm thời |

Không expose public các port này:

- PostgreSQL `5432`
- MongoDB `27017`
- Redis `6379`
- Kafka `9092`, `29092`
- Auth service `3001`
- Notification service `3006`
- Các service nội bộ `3002-3009`

Các port nội bộ nên chỉ đi qua Docker network hoặc security group private.

### 3.3. Elastic IP

Nên gắn Elastic IP cho EC2 để IP không đổi khi reboot:

1. EC2 Console.
2. Elastic IPs.
3. Allocate Elastic IP address.
4. Associate Elastic IP.
5. Chọn instance `bin-ecommerce-prod`.

## 4. SSH vào EC2

Trên Windows PowerShell:

```powershell
cd $HOME\Downloads
ssh -i .\your-key.pem ec2-user@YOUR_EC2_PUBLIC_IP
```

Nếu bị lỗi permission trên Windows, dùng:

```powershell
icacls .\your-key.pem /inheritance:r
icacls .\your-key.pem /grant:r "$env:USERNAME:R"
ssh -i .\your-key.pem ec2-user@YOUR_EC2_PUBLIC_IP
```

Sau khi vào server, update package:

```bash
sudo dnf update -y
```

## 5. Cài Docker, Git, Node.js trên EC2

### 5.1. Cài Docker

```bash
sudo dnf install -y docker git
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ec2-user
```

Đăng xuất SSH rồi đăng nhập lại:

```bash
exit
ssh -i your-key.pem ec2-user@YOUR_EC2_PUBLIC_IP
```

Kiểm tra Docker:

```bash
docker version
docker info
```

### 5.2. Kiểm tra Docker Compose

```bash
docker compose version
```

Nếu server chưa có Docker Compose plugin, cài theo Docker documentation hoặc dùng package/plugin phù hợp với Amazon Linux 2023. Sau khi cài, câu lệnh này phải chạy được:

```bash
docker compose version
```

### 5.3. Cài Node.js 20+

Dự án yêu cầu Node >= 20 và npm >= 10.

```bash
node -v
npm -v
```

Nếu chưa có Node:

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
node -v
npm -v
```

## 6. Tạo swap để tránh thiếu RAM

Nếu dùng `t3.micro`, nên tạo swap 4 GB. Kafka + Keycloak + NestJS dễ ngốn RAM.

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

Khuyến nghị:

- Demo ít traffic: 4 GB swap.
- Chạy nhiều service hơn: 6-8 GB swap hoặc nâng instance.

## 7. Clone source code lên EC2

Chọn thư mục deploy:

```bash
sudo mkdir -p /opt/bin-ecommerce
sudo chown -R ec2-user:ec2-user /opt/bin-ecommerce
cd /opt/bin-ecommerce
```

Clone repo kèm submodule:

```bash
git clone --recurse-submodules https://github.com/Bin-E-Commerce/Bin-Ecommerce.git .
```

Nếu đã clone nhưng thiếu submodule:

```bash
git submodule update --init --recursive
```

Kiểm tra:

```bash
git status
git submodule status
ls services
ls web
```

## 8. Tạo file env production

Copy env mẫu:

```bash
cp .env.example .env
nano .env
```

Ví dụ `.env` cho single EC2:

```env
NODE_ENV=production

POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=bin_ecommerce
POSTGRES_PASSWORD=CHANGE_ME_STRONG_POSTGRES_PASSWORD
POSTGRES_DB=bin_ecommerce

MONGO_ROOT_USER=root
MONGO_ROOT_PASSWORD=CHANGE_ME_STRONG_MONGO_PASSWORD
MONGODB_URI=mongodb://root:CHANGE_ME_STRONG_MONGO_PASSWORD@mongodb:27017/bin_ecommerce?authSource=admin

REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

KAFKA_BROKERS=kafka:9092
KAFKA_CLIENT_ID=bin-ecommerce
KAFKA_GROUP_ID_PREFIX=bin-ecommerce

KEYCLOAK_URL=http://keycloak:8080
KEYCLOAK_REALM=bin-ecommerce
KEYCLOAK_CLIENT_ID=api-gateway
KEYCLOAK_CLIENT_SECRET=CHANGE_ME_KEYCLOAK_CLIENT_SECRET
KEYCLOAK_ADMIN_CLIENT_ID=admin-cli
KEYCLOAK_ADMIN_CLIENT_SECRET=CHANGE_ME_KEYCLOAK_ADMIN_CLIENT_SECRET
KEYCLOAK_WEB_CLIENT_ID=web-client
KEYCLOAK_ADMIN_USER=admin
KEYCLOAK_ADMIN_PASSWORD=CHANGE_ME_KEYCLOAK_ADMIN_PASSWORD

FRONTEND_URL=https://your-web-domain.vercel.app
AUTH_SERVICE_URL=http://auth-service:3001
PRODUCT_SERVICE_URL=http://product-service:3002
CART_SERVICE_URL=http://cart-service:3003
ORDER_SERVICE_URL=http://order-service:3004
INVENTORY_SERVICE_URL=http://inventory-service:3005
NOTIFICATION_SERVICE_URL=http://notification-service:3006
SHIPPING_SERVICE_URL=http://shipping-service:3007
PROMOTION_SERVICE_URL=http://promotion-service:3008
RETURN_SERVICE_URL=http://return-service:3009

ALLOWED_ORIGINS=https://your-web-domain.vercel.app,http://localhost:5173

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@example.com
SMTP_PASSWORD=CHANGE_ME_SMTP_APP_PASSWORD
SMTP_FROM=noreply@your-domain.com

GRAFANA_ADMIN_PASSWORD=CHANGE_ME_GRAFANA_PASSWORD
```

Quan trọng:

- Không commit `.env`.
- Dùng password mạnh cho PostgreSQL, MongoDB, Keycloak, Grafana.
- `ALLOWED_ORIGINS` chỉ nên chứa domain frontend thật khi production.
- `KEYCLOAK_URL=http://keycloak:8080` dùng cho container nội bộ.
- Nếu frontend cần login OAuth qua browser, Keycloak public URL nên có domain public riêng, ví dụ `https://auth.your-domain.com`. Khi đó cần cấu hình lại Nginx và Keycloak hostname.

## 9. Chạy infra trên EC2

Từ root repo:

```bash
cd /opt/bin-ecommerce
docker compose -f infra/docker/docker-compose.infra.yml up -d
```

Xem trạng thái:

```bash
docker compose -f infra/docker/docker-compose.infra.yml ps
docker logs bin_postgres --tail=100
docker logs bin_mongodb --tail=100
docker logs bin_redis --tail=100
docker logs bin_kafka --tail=100
docker logs bin_keycloak --tail=100
```

Chờ các service healthy:

```bash
docker compose -f infra/docker/docker-compose.infra.yml ps
```

Nếu Kafka hoặc Keycloak khởi động lâu trên máy yếu, chờ 1-3 phút rồi kiểm tra lại.

## 10. Cấu hình Keycloak lần đầu

Mở trình duyệt:

```text
http://YOUR_EC2_PUBLIC_IP:8080
```

Đăng nhập bằng:

```text
username: KEYCLOAK_ADMIN_USER
password: KEYCLOAK_ADMIN_PASSWORD
```

Tạo realm:

```text
bin-ecommerce
```

Tạo client cho backend:

```text
Client ID: api-gateway
Client authentication: On
Standard flow: On nếu cần OAuth redirect
Direct access grants: On nếu auth-service dùng password grant
Service accounts: On nếu cần Admin API
Valid redirect URIs:
  https://your-web-domain.vercel.app/*
  http://localhost:5173/*
Web origins:
  https://your-web-domain.vercel.app
  http://localhost:5173
```

Copy client secret vào `.env`:

```env
KEYCLOAK_CLIENT_SECRET=...
```

Tạo client cho frontend:

```text
Client ID: web-client
Client authentication: Off
Standard flow: On
Valid redirect URIs:
  https://your-web-domain.vercel.app/auth/callback
  https://your-web-domain.vercel.app/auth/*
  http://localhost:5173/auth/callback
Web origins:
  https://your-web-domain.vercel.app
  http://localhost:5173
```

Nếu code đang dùng role:

- Tạo realm roles: `USER`, `ADMIN`.
- Gán role cho user test.
- Đảm bảo JWT có roles đúng format mà `api-gateway` đang đọc.

Sau khi sửa `.env`, restart service backend ở các bước sau.

## 11. Build và chạy backend services

Build image:

```bash
cd /opt/bin-ecommerce
docker compose build
```

Run:

```bash
docker compose up -d
```

Kiểm tra:

```bash
docker compose ps
docker logs api-gateway --tail=100
docker logs auth-service --tail=100
docker logs nginx --tail=100
```

Health check trực tiếp:

```bash
curl http://localhost:3000/api/health
curl http://localhost:3001/api/health
```

Health check qua Nginx:

```bash
curl http://localhost/api/health
```

Từ máy local:

```bash
curl http://YOUR_EC2_PUBLIC_IP/api/health
```

## 12. Cấu hình domain

Giả sử domain:

```text
api.your-domain.com
```

Tạo DNS A record:

```text
Name: api
Type: A
Value: YOUR_EC2_ELASTIC_IP
TTL: 300
```

Nếu dùng Route 53:

1. Vào Route 53.
2. Hosted zones.
3. Chọn domain.
4. Create record.
5. Record name: `api`.
6. Record type: `A`.
7. Value: Elastic IP của EC2.
8. Save.

Kiểm tra DNS:

```bash
nslookup api.your-domain.com
curl http://api.your-domain.com/api/health
```

## 13. Cấu hình HTTPS bằng Certbot

### 13.1. Cài Certbot trên EC2

```bash
sudo dnf install -y python3 python3-pip
python3 -m pip install --user certbot
```

Thêm certbot vào PATH nếu cần:

```bash
export PATH=$PATH:$HOME/.local/bin
certbot --version
```

### 13.2. Tạm dừng Nginx container để cấp cert

Certbot standalone cần port 80 rảnh:

```bash
docker stop nginx
```

Cấp cert:

```bash
certbot certonly --standalone -d api.your-domain.com
```

Cert sẽ nằm ở:

```text
/etc/letsencrypt/live/api.your-domain.com/fullchain.pem
/etc/letsencrypt/live/api.your-domain.com/privkey.pem
```

### 13.3. Mount cert vào Nginx container

Tạo thư mục SSL trong repo:

```bash
mkdir -p infra/nginx/ssl/api.your-domain.com
sudo cp /etc/letsencrypt/live/api.your-domain.com/fullchain.pem infra/nginx/ssl/api.your-domain.com/fullchain.pem
sudo cp /etc/letsencrypt/live/api.your-domain.com/privkey.pem infra/nginx/ssl/api.your-domain.com/privkey.pem
sudo chown -R ec2-user:ec2-user infra/nginx/ssl
```

Sửa `infra/nginx/conf.d/default.conf` để thêm server HTTPS:

```nginx
server {
    listen 80;
    server_name api.your-domain.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

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
    }
}
```

Test Nginx:

```bash
docker compose up -d nginx
docker exec nginx nginx -t
curl https://api.your-domain.com/api/health
```

### 13.4. Renew certificate

Kiểm tra renew:

```bash
certbot renew --dry-run
```

Tạo cron:

```bash
crontab -e
```

Thêm:

```cron
0 3 * * * $HOME/.local/bin/certbot renew --quiet && docker restart nginx
```

Nếu dùng cách copy cert vào repo như trên, cần script sync cert sau renew. Với production chuẩn hơn, mount trực tiếp `/etc/letsencrypt` vào container read-only.

## 14. Deploy frontend lên Vercel

Frontend nằm trong submodule `web/`.

### 14.1. Import project

1. Vào Vercel.
2. Add New Project.
3. Import repository frontend: `Bin-E-Commerce-UI-Web`.
4. Framework: Next.js.
5. Root directory: giữ root của repo frontend nếu repo riêng chỉ chứa web.

### 14.2. Environment Variables trên Vercel

Thêm:

```env
NEXT_PUBLIC_API_URL=https://api.your-domain.com
NEXT_PUBLIC_KEYCLOAK_URL=https://auth.your-domain.com
NEXT_PUBLIC_KEYCLOAK_REALM=bin-ecommerce
NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=web-client
NEXT_PUBLIC_APP_URL=https://your-web-domain.vercel.app
```

Nếu chưa expose Keycloak qua domain riêng, tạm dùng:

```env
NEXT_PUBLIC_KEYCLOAK_URL=http://YOUR_EC2_PUBLIC_IP:8080
```

Nhưng production thật nên dùng HTTPS domain cho Keycloak.

### 14.3. Build command

Vercel thường tự nhận:

```bash
npm install
npm run build
```

Nếu build lỗi type-check, cần sửa lỗi web trước rồi deploy lại.

## 15. CORS production

Trong `api-gateway`, CORS đọc từ:

```env
ALLOWED_ORIGINS=https://your-web-domain.vercel.app
```

Nếu có nhiều origin:

```env
ALLOWED_ORIGINS=https://your-web-domain.vercel.app,https://www.your-domain.com
```

Không để dạng bị browser hiểu thành một header nhiều giá trị sai format. Code hiện tại đã split dấu phẩy thành array, nhưng giá trị env phải sạch, không có khoảng trắng lạ.

Sau khi sửa `.env`:

```bash
docker compose up -d --force-recreate api-gateway nginx
```

## 16. Lệnh deploy hằng ngày

Khi có code mới:

```bash
cd /opt/bin-ecommerce
git pull
git submodule update --init --recursive
npm install
docker compose -f infra/docker/docker-compose.infra.yml up -d
docker compose build
docker compose up -d
docker compose ps
```

Nếu chỉ đổi code backend:

```bash
git pull
git submodule update --init --recursive
docker compose build api-gateway auth-service notification-service
docker compose up -d api-gateway auth-service notification-service nginx
```

Nếu chỉ đổi env:

```bash
nano .env
docker compose up -d --force-recreate
```

## 17. Logs và debug

Xem toàn bộ app:

```bash
docker compose logs -f
```

Xem từng service:

```bash
docker logs -f api-gateway
docker logs -f auth-service
docker logs -f nginx
docker logs -f bin_keycloak
docker logs -f bin_kafka
```

Vào container:

```bash
docker exec -it api-gateway sh
docker exec -it auth-service sh
docker exec -it nginx sh
```

Kiểm tra network:

```bash
docker network ls
docker network inspect bin_infra_net
docker network inspect e-commerce_bin_app_net
```

Kiểm tra API trong network:

```bash
docker exec -it nginx wget -qO- http://api-gateway:3000/api/health
docker exec -it api-gateway wget -qO- http://auth-service:3001/api/health
```

## 18. Backup dữ liệu

Vì bản single EC2 dùng Docker volume, backup là bắt buộc.

### 18.1. Backup PostgreSQL

```bash
mkdir -p ~/backups/postgres
docker exec bin_postgres pg_dumpall -U bin_ecommerce > ~/backups/postgres/all-$(date +%F-%H%M).sql
```

Restore:

```bash
cat ~/backups/postgres/all-YYYY-MM-DD-HHMM.sql | docker exec -i bin_postgres psql -U bin_ecommerce
```

### 18.2. Backup MongoDB

```bash
mkdir -p ~/backups/mongodb
docker exec bin_mongodb mongodump \
  --username root \
  --password CHANGE_ME_STRONG_MONGO_PASSWORD \
  --authenticationDatabase admin \
  --archive > ~/backups/mongodb/mongo-$(date +%F-%H%M).archive
```

Restore:

```bash
cat ~/backups/mongodb/mongo-YYYY-MM-DD-HHMM.archive | docker exec -i bin_mongodb mongorestore \
  --username root \
  --password CHANGE_ME_STRONG_MONGO_PASSWORD \
  --authenticationDatabase admin \
  --archive
```

### 18.3. Copy backup về máy local

Từ máy local:

```powershell
scp -i .\your-key.pem ec2-user@YOUR_EC2_PUBLIC_IP:/home/ec2-user/backups/postgres/all-YYYY-MM-DD-HHMM.sql .
scp -i .\your-key.pem ec2-user@YOUR_EC2_PUBLIC_IP:/home/ec2-user/backups/mongodb/mongo-YYYY-MM-DD-HHMM.archive .
```

## 19. Rollback

Rollback bằng Git:

```bash
cd /opt/bin-ecommerce
git log --oneline -n 10
git checkout COMMIT_SHA
git submodule update --init --recursive
docker compose build
docker compose up -d
```

Quay lại main:

```bash
git checkout main
git pull
git submodule update --init --recursive
docker compose build
docker compose up -d
```

Nếu deploy bằng image tag trong tương lai, rollback tốt hơn là đổi image tag về version cũ.

## 20. CI/CD GitHub Actions qua SSH

Đây là hướng đơn giản: GitHub Actions SSH vào EC2, pull code và restart Docker Compose.

### 20.1. Tạo SSH key deploy

Trên máy local:

```bash
ssh-keygen -t ed25519 -C "github-actions-bin-ecommerce" -f ./bin-ecommerce-deploy
```

Copy public key lên EC2:

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

Paste public key vào `authorized_keys`.

### 20.2. Thêm GitHub Secrets

Trong GitHub repo root:

```text
EC2_HOST=YOUR_EC2_PUBLIC_IP_OR_DOMAIN
EC2_USER=ec2-user
EC2_SSH_KEY=private key content of bin-ecommerce-deploy
EC2_APP_DIR=/opt/bin-ecommerce
```

### 20.3. Workflow mẫu

Tạo `.github/workflows/deploy-ec2.yml`:

```yaml
name: Deploy EC2

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ${{ secrets.EC2_USER }}
          key: ${{ secrets.EC2_SSH_KEY }}
          script: |
            set -e
            cd ${{ secrets.EC2_APP_DIR }}
            git fetch --all
            git checkout main
            git pull
            git submodule update --init --recursive
            npm install
            docker compose -f infra/docker/docker-compose.infra.yml up -d
            docker compose build
            docker compose up -d
            docker compose ps
            curl -f http://localhost:3000/api/health
```

Với repo có submodule private, cần đảm bảo EC2 có quyền pull từng submodule.

## 21. Nâng cấp sang RDS PostgreSQL

Khi không muốn giữ PostgreSQL trong Docker:

1. Tạo RDS PostgreSQL 16.
2. Public access: No nếu EC2 cùng VPC.
3. Security group của RDS chỉ cho phép inbound từ security group của EC2 ở port `5432`.
4. Sửa `.env`:

```env
POSTGRES_HOST=your-rds-endpoint.amazonaws.com
POSTGRES_PORT=5432
POSTGRES_USER=bin_ecommerce
POSTGRES_PASSWORD=...
POSTGRES_DB=bin_ecommerce
```

5. Comment hoặc tắt service `postgres` trong `infra/docker/docker-compose.infra.yml`.
6. Restart app:

```bash
docker compose up -d --force-recreate
```

Lưu ý:

- `db-init` hiện tạo database trong PostgreSQL local. Khi dùng RDS, bạn nên tạo database bằng script riêng hoặc migration tool.
- Đảm bảo database name trong compose/env khớp với code. Hiện root `.env.example` dùng `bin_ecommerce`, còn `docker-compose.yml` cho `auth-service` đang dùng `bin_auth`. Cần thống nhất trước khi production thật.

## 22. Nâng cấp sang MongoDB Atlas

1. Tạo cluster M0/M2 trên MongoDB Atlas.
2. Tạo database user.
3. Network access:
   - Demo: allow IP của EC2.
   - Không nên mở `0.0.0.0/0` lâu dài.
4. Lấy connection string.
5. Sửa `.env`:

```env
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster.mongodb.net/bin_ecommerce?retryWrites=true&w=majority
```

6. Tắt `mongodb` local nếu không dùng:

```bash
docker compose -f infra/docker/docker-compose.infra.yml stop mongodb
```

7. Restart service cần MongoDB:

```bash
docker compose up -d --force-recreate notification-service
```

## 23. Tách EC2 app và EC2 infra

Khi muốn giống sơ đồ deploy 2 máy:

### 23.1. EC2-B infra

Chạy:

```bash
docker compose -f infra/docker/docker-compose.infra.yml up -d
```

Security group EC2-B chỉ cho EC2-A truy cập:

| Port | Source |
| --- | --- |
| 5432 | Security group EC2-A |
| 27017 | Security group EC2-A |
| 6379 | Security group EC2-A |
| 9092 | Security group EC2-A |
| 8080 | Security group EC2-A hoặc Your IP |
| 9090 | Your IP |
| 3030 | Your IP |

### 23.2. EC2-A app

Chạy:

```bash
docker compose up -d
```

Sửa `.env` trên EC2-A:

```env
POSTGRES_HOST=PRIVATE_IP_EC2_B
MONGODB_URI=mongodb://root:PASSWORD@PRIVATE_IP_EC2_B:27017/bin_ecommerce?authSource=admin
REDIS_HOST=PRIVATE_IP_EC2_B
KAFKA_BROKERS=PRIVATE_IP_EC2_B:9092
KEYCLOAK_URL=http://PRIVATE_IP_EC2_B:8080
```

Kafka cần advertised listener phù hợp private IP, không dùng `localhost` cho app server.

## 24. Checklist sau deploy

Backend:

```bash
curl https://api.your-domain.com/api/health
curl https://api.your-domain.com/api/v1/auth/health
```

Auth:

```bash
curl -X POST https://api.your-domain.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"your-password"}'
```

Container:

```bash
docker ps
docker compose ps
docker compose -f infra/docker/docker-compose.infra.yml ps
```

Logs:

```bash
docker logs api-gateway --tail=200
docker logs auth-service --tail=200
docker logs nginx --tail=200
docker logs bin_keycloak --tail=200
```

Frontend:

- Mở web Vercel.
- Test login.
- Test refresh page sau login.
- Test CORS bằng request từ domain Vercel sang API domain.
- Mở DevTools Network xem request `/api/v1/auth/login`.

## 25. Lỗi thường gặp

### 25.1. CORS bị multiple origin

Triệu chứng:

```text
Access-Control-Allow-Origin contains multiple values
```

Cách xử lý:

```env
ALLOWED_ORIGINS=https://your-web-domain.vercel.app
```

Sau đó:

```bash
docker compose up -d --force-recreate api-gateway
```

### 25.2. API Gateway không gọi được Auth Service

Kiểm tra env:

```env
AUTH_SERVICE_URL=http://auth-service:3001
```

Kiểm tra network:

```bash
docker exec -it api-gateway wget -qO- http://auth-service:3001/api/health
```

### 25.3. Keycloak token verify fail

Kiểm tra:

- `KEYCLOAK_URL`
- `KEYCLOAK_REALM`
- Client ID/secret
- Realm public key/JWKS URL
- Token issuer có khớp URL mà gateway dùng để verify không

Nếu browser dùng `https://auth.your-domain.com` nhưng backend verify bằng `http://keycloak:8080`, cần đảm bảo issuer/JWKS logic trong code chịu được hostname đó, hoặc cấu hình Keycloak hostname nhất quán.

### 25.4. Kafka không connect

Trong container app, broker phải là:

```env
KAFKA_BROKERS=kafka:9092
```

Không dùng:

```env
KAFKA_BROKERS=localhost:9092
```

vì `localhost` bên trong container là chính container đó.

### 25.5. EC2 hết RAM

Kiểm tra:

```bash
free -h
docker stats
```

Cách xử lý:

- Tăng swap.
- Tắt Grafana/Prometheus nếu chưa cần.
- Tắt service chưa dùng.
- Nâng instance lên `t3.small` hoặc `t3.medium`.

### 25.6. Nginx container restart liên tục

Kiểm tra:

```bash
docker logs nginx
docker exec nginx nginx -t
```

Nguyên nhân hay gặp:

- Comment `//` trong file `.conf`.
- Sai upstream name.
- Sai đường dẫn certificate.
- Port 80/443 đã bị process khác chiếm.

## 26. Cấu trúc lệnh nhanh

Deploy lần đầu:

```bash
sudo dnf update -y
sudo dnf install -y docker git
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ec2-user
exit
```

Đăng nhập lại:

```bash
sudo mkdir -p /opt/bin-ecommerce
sudo chown -R ec2-user:ec2-user /opt/bin-ecommerce
cd /opt/bin-ecommerce
git clone --recurse-submodules https://github.com/Bin-E-Commerce/Bin-Ecommerce.git .
cp .env.example .env
nano .env
docker compose -f infra/docker/docker-compose.infra.yml up -d
docker compose build
docker compose up -d
curl http://localhost:3000/api/health
```

Deploy update:

```bash
cd /opt/bin-ecommerce
git pull
git submodule update --init --recursive
docker compose build
docker compose up -d
docker compose ps
curl http://localhost:3000/api/health
```

Stop:

```bash
docker compose down
docker compose -f infra/docker/docker-compose.infra.yml down
```

Stop và xóa volume dữ liệu local:

```bash
docker compose down -v
docker compose -f infra/docker/docker-compose.infra.yml down -v
```

> Cẩn thận: `down -v` xóa database volume. Chỉ dùng khi chắc chắn không cần dữ liệu.

## 27. Nguồn đối chiếu

- AWS EC2 / Amazon Linux 2023 Docker setup: https://docs.aws.amazon.com/AmazonECR/latest/public/getting-started-cli.html
- Amazon Linux 2023 container/runtime notes: https://docs.aws.amazon.com/linux/al2023/ug/container.html
- Route 53 record creation: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html
- Route 53 DNS record types: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/ResourceRecordTypes.html
