#!/bin/bash

set -o allexport
. ./mongo-rs.env

# Docker node - local build
sudo cp -rvf Dockerfile* .. && \
cd .. && \
docker build . -t ${STACK_NAME}:latest

# Dockerhub registry
# docker login
# sudo cp -rvf Dockerfile* ..
# docker buildx build --platform "linux/amd64,linux/arm64,linux/arm/v7" -t jackietreehorn/${STACK_NAME}:noconfig --push ..