# Book of Business — server edition (Render-ready)
FROM node:22-slim AS build
WORKDIR /app
# Build tools for better-sqlite3's native module
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:server-ui && node server/build.cjs

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist-server ./dist-server
# DATA_DIR is mounted as a Render persistent disk (see render.yaml)
ENV DATA_DIR=/var/data
EXPOSE 3000
CMD ["node", "dist-server/server/src/server.js"]
