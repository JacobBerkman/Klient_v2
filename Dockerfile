FROM node:22-alpine
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["node", "apps/api/src/server.mjs"]
