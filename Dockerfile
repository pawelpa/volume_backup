FROM node:trixie-slim
WORKDIR /app
COPY . .
CMD ["node","index.js"]
