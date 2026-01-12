FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

COPY server.js ./server.js

EXPOSE 9000

CMD ["node", "server.js"]
