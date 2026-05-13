FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3140

COPY --chown=node:node package.json ./
COPY --chown=node:node server.js contractflow.html ./
COPY --chown=node:node public ./public

RUN mkdir -p data/uploads && chown -R node:node /app/data

USER node

EXPOSE 3140

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null || exit 1

CMD ["node", "server.js"]
