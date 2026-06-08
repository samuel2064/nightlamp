FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:20-alpine AS runner
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist/ ./dist/
COPY .env.example ./.env

RUN mkdir -p /app/data /app/playbook

EXPOSE 10000

CMD ["node", "dist/index.js"]