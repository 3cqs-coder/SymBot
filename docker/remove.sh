#!/bin/bash

set -o allexport
. ./mongo-rs.env

docker stack rm ${STACK_NAME}
# Do NOT remove existing network if planning to redeploy upon existing replica
# docker network rm ${BACKEND_NETWORK_NAME}
docker secret rm mongo-keyfile
