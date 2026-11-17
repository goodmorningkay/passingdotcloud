FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
ENV NEXT_TELEMETRY_DISABLED=1
ENV API_ORIGIN=http://api:4000
COPY . .
RUN npm run build

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY LICENSE ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS api-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM api-dependencies AS api
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --chown=node:node server ./server
COPY --chown=node:node lib/shared ./lib/shared
COPY LICENSE ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4000
CMD ["node", "--import", "tsx", "server/index.ts"]
