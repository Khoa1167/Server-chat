# mediasoup: prebuilt worker binary tải về có thể không chạy được trên host build (thiếu shared lib
# ở bookworm-slim) — npm tự fallback biên dịch từ source, cần python3 + build-essential. Build 2 giai
# đoạn để toolchain biên dịch không nằm trong image chạy thật (giảm kích thước + bề mặt tấn công).
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip build-essential \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Không chạy container bằng root — node:22-bookworm-slim đã có sẵn user 'node' không cần tạo mới.
USER node

EXPOSE 5000

CMD ["node", "src/index.js"]
