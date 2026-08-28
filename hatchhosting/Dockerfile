# HatchHosting panel - static site (separate Railway service from the relay).
FROM node:20-alpine
WORKDIR /app
COPY server.js index.html ./
EXPOSE 8080
CMD ["node", "server.js"]
