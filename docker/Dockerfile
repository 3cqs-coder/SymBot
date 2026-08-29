# Build - Use full node.js parent image.
# Pinned to 22.15 to match package.json's engines.node (>=22.15.0) — the Docker and non-Docker minimums
# are kept identical. The 22.15 floor is the higher of two dependency requirements: Node's built-in SQLite
# (node:sqlite, used by the Hub storage) is flag-free from 22.13+, and http-proxy-middleware (the Hub's
# instance proxy) requires ^22.15.0. Bump this in lockstep with package.json if the minimum ever rises.
FROM node:22.15 AS builder

# Set working directory
WORKDIR /usr/src/app

# Process package.json / *lock.json first (leverage Docker cache)
COPY package*.json ./

# Install only PROD dependencies
RUN npm install --omit=dev

# Copy app contents into working directory
COPY . .


# Install - Use slimmer Alpine image. Pinned to 22.15-alpine to match the builder and package.json.
# node:sqlite is built into the Node binary, so it needs no native build tools on Alpine/musl.
FROM node:22.15-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy application and node_modules from builder stage
COPY --from=builder /usr/src/app .

# Add curl to Alpine image
RUN apk add --no-cache curl

# Create non-root container user | prepare dir structure | grant ownership.
# Pre-create every directory that docker-compose persists as a named volume (config, data, backups,
# uploads, logs, rollbacks) BEFORE the chown and before those volumes mount. A named volume seeds its
# contents AND ownership from the image directory it covers on first creation, so these must exist and
# be owned by the non-root symbot user or the app could not write to a freshly-mounted volume.
RUN addgroup -S symbot && adduser -S symbot -G symbot && \
    mkdir -p /usr/src/app/config /usr/src/app/data /usr/src/app/backups \
             /usr/src/app/uploads /usr/src/app/logs /usr/src/app/rollbacks && \
    chown -R symbot:symbot /usr/src/app

# Switch to non-root user
USER symbot:symbot

# Environment variables
# DOCKER_RUNNING switches SymBot to its container defaults: when the config's mongo_db_url is
# empty it connects to mongodb://symbot:symbot123@database/symbot (the compose "database" service,
# seeded by db-init.js). To point at a different database, set mongo_db_url in a mounted app.json —
# SymBot is configured through its config file, not environment variables.
ENV DOCKER_RUNNING=true

# Expose the application port
EXPOSE 3000

# Start application
CMD ["sh", "-c", "echo 'Warming up' && sleep 5 && exec npm start"]