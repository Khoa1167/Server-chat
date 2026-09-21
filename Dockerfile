FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Không chạy container bằng root — node:22-bookworm-slim đã có sẵn user 'node' không cần tạo mới.
USER node

EXPOSE 5000

CMD ["node", "src/index.js"]
