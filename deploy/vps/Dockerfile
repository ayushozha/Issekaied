FROM oven/bun:1.3.9 AS dependencies
WORKDIR /app/server
COPY server/package.json server/bun.lock ./
RUN bun install --production --frozen-lockfile

FROM dependencies AS runtime
WORKDIR /app
COPY server/src ./server/src
COPY server/config ./server/config
COPY shared ./shared
COPY actor/src ./actor/src
ENV HOST=0.0.0.0 PORT=8791 ISSEKAIED_DATA_DIR=/data
USER bun
EXPOSE 8791
CMD ["bun", "server/src/index.ts"]
