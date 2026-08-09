FROM node:22-alpine

WORKDIR /app

# No dependencies — server.js is Node stdlib only, so there is no install step.
COPY server.js index.html manifest.webmanifest ./
COPY icons ./icons

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

EXPOSE 8080
VOLUME ["/data"]

USER node

CMD ["node", "server.js"]
