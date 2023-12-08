FROM python:3.11.6-alpine3.18

RUN pip install docker
RUN pip install pymongo==4.6.1
RUN pip install backoff

RUN mkdir /src
WORKDIR /src

COPY src/db-replica_ctrl.py /src/db-replica_ctrl.py