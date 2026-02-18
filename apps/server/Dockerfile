FROM node:20-alpine AS build
WORKDIR /app

# Install only server workspace dependencies for build
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
RUN npm ci --workspace apps/server --include-workspace-root=false

COPY apps/server apps/server
WORKDIR /app/apps/server
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app

# Install runtime dependencies only for server workspace
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
RUN npm ci --omit=dev --workspace apps/server --include-workspace-root=false

COPY --from=build /app/apps/server/dist /app/apps/server/dist

WORKDIR /app/apps/server
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

CMD ["node", "dist/index.js"]
