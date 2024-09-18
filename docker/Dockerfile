# Build - Use full node.js parent image
FROM node:22 AS builder

# Set working directory
WORKDIR /usr/src/app

# Process package.json / *lock.json first (leverage Docker cache)
COPY package*.json ./

# Install only PROD dependencies
RUN npm install --omit=dev

# Copy app contents into working directory
COPY . .


# Install - Use slimmer Alpine image
FROM node:22-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy application and node_modules from builder stage
COPY --from=builder /usr/src/app .

# Add curl to Alpine image
RUN apk add --no-cache curl

# Create non-root container user | prepare dir structure | grant ownership
RUN addgroup -S symbot && adduser -S symbot -G symbot && \
    mkdir -p /usr/src/app/logs && chown -R symbot:symbot /usr/src/app

# Switch to non-root user
USER symbot:symbot

# Environment variables
ENV DOCKER_RUNNING=true \
    MONGODB_URI='mongodb://localhost:27017/symbot'

# Expose the application port
EXPOSE 3000

# Start application
CMD ["sh", "-c", "echo 'Warming up' && sleep 5 && exec npm start"]