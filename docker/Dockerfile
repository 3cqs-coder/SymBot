# Use Node.js as parent image
FROM node:21

# Create an environment variable for MongoDB
ENV DOCKER_RUNNING=true \
    MONGODB_URI='mongodb://localhost:27017/symbot'

# Set working directory to /usr/src/app
WORKDIR /usr/src/app

# Copy SymBot app contents into the working directory of docker image
COPY . .

# Install SymBot package dependencies
RUN npm install

# SymBot
EXPOSE 3000

# Wait 30 seconds for the MongoDB ReplicaSet build & connection
CMD echo "Warming up" && sleep 30 && npm start