# Use Node.js as parent image
FROM node:19.2

ENV DOCKER_RUNNING=true

# Create an environment variable for MongoDB
ENV MONGODB_URI='mongodb://localhost:27017/symbot'

# Set working directory to /usr/src/app
WORKDIR /usr/src/app

# Copy SymBot app contents into the working directory of docker image
COPY . /usr/src/app/

# Install SymBot package dependencies
RUN npm install

# SymBot
EXPOSE 3000

# Mongo Express
EXPOSE 3010

# Wait 100 seconds for the MongoDB ReplicaSet build & connection
CMD echo "Warming up" && sleep 90 && npm start