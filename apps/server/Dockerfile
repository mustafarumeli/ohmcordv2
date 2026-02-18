FROM node:20-alpine AS build
WORKDIR /app

# Build context: apps/server
COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY --from=build /app/dist /app/dist

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

CMD ["node", "dist/index.js"]
