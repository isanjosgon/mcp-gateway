FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY gateway/package.json ./gateway/package.json
RUN npm ci --omit=dev --workspace gateway

COPY gateway/src ./gateway/src

WORKDIR /app/gateway

EXPOSE 8080

CMD ["node", "src/cli.js", "run", "-c", "/config/config.yml"]
