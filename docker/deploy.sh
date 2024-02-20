#!/bin/bash

set -o allexport
. ./mongo-rs.env

# Use to avoid subnet overlaps - specify your own subnet
# docker network create --opt encrypted -d overlay --subnet=10.0.25.0/24 --gateway=10.0.25.1  ${BACKEND_NETWORK_NAME}

docker network create --opt encrypted -d overlay ${BACKEND_NETWORK_NAME}
openssl rand -base64 741 | docker secret create mongo-keyfile -
docker stack deploy -c docker-compose-stack.yml ${STACK_NAME}