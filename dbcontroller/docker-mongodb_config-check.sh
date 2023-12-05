#!/bin/bash

# Run this script on any docker host in your swarm to interrogate a mongodb container and provide replicaset
# status and replicaset config, which displays 'primary' node, and other helpful info - useful for validating config or troubleshooting

# Environment variables
set -o allexport
. ../docker/mongo-rs.env

# Get the container ID of the MongoDB service
MONGO_CONTAINER_ID=$(docker ps --filter name=${MONGO_SERVICE_URI} --format "{{.ID}}")

# Check if a container ID was found
if [ -z "$MONGO_CONTAINER_ID" ]; then
    echo "MongoDB container not found."
    exit 1
fi

# Execute the script in the MongoDB container
docker exec -i $MONGO_CONTAINER_ID mongosh -u "$MONGO_ROOT_USERNAME" -p "$MONGO_ROOT_PASSWORD" admin <<EOF
rs.status();
rs.config();
db.getMongo();
EOF