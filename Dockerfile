FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Không chạy container bằng root — node:22-alpine đã có sẵn user 'node' không cần tạo mới.
USER node

EXPOSE 5000

CMD ["node", "src/index.js"]
