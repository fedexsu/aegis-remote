# Aegis Remote — relay service (cloud deploy).
# Builds a tiny image with ONLY the relay + console + the `ws` dependency
# (Electron and build tooling are skipped via --omit=dev).
FROM node:20-alpine

WORKDIR /app

# Install production deps only (just `ws`).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy the relay + console (server/public).
COPY server ./server

# Bake the installer in so /dl serves it with no manual upload needed.
COPY release/support.exe ./release/support.exe
COPY release/support-service.exe ./release/support-service.exe
COPY release/HatchConnect-Setup.exe ./release/HatchConnect-Setup.exe

ENV NODE_ENV=production
# Hosts (Render/Railway/Fly) inject PORT; relay.js reads process.env.PORT.
EXPOSE 8080

CMD ["node", "server/relay.js"]
