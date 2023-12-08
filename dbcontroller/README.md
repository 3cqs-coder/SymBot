
# MongoDB ReplicaSet Manager for Docker Swarm

`Version: 1.01`

## Introduction
This tool automates the configuration, initiation, monitoring, and management of a MongoDB replica set within a Docker Swarm environment. It ensures continuous operation, and adapts to changes within the Swarm network, ensuring high availability and consistency of data.

## Features
- ✅ **Automated ReplicaSet Initialization**: configures and initiates MongoDB replica set from scratch, determines the number of nodes in the MongoDB global service to wait for, taking into account 'down' nodes or nodes marked as 'unavailable' in the swarm.<br/>

- ✅ **Primary Node Tracking & Configuration for ReplicaSet**: automatic replicaset primary designation and tracking on new & existing deployments.<br/>
- ✅ **Dynamic ReplicaSet Reconfiguration**: adjusts the replica set as MongoDB instance IPs change within Docker Swarm. Checks if a replicaset is already configured or being redeployed and adjusts members accordingly.<br/>
- ✅ **Resilience and Redundancy**: ensures the replica set's stability and availability, even during node changes. In case the primary node is lost, it waits for a new election or forces reconfiguration when the replica-set is inconsistent.<br/>
- ✅ **Mongo Admin and init User Setup**: automates the creation of MongoDB admin (root) account as well as an initial db user & associated collection/db insertion for your main application/service using mongo.<br/>
- ✅ **Continuous Monitoring**: watches for changes in the Docker Swarm topology. Continuously listens for changes in IP addresses or MongoDB instances removals and/or additions and adjusts the replica set accordingly. Tested againts a wide variety of potential outage edge cases to ensure reliability.<br/>
- ✅ **Error Handling and Detailed Logging**: provides comprehensive logging for efficient troubleshooting.<br/>
- ✅ **Scalability**: Designed to work with multiple nodes in a Docker Swarm environment and scale the ReplicaSet automatically as additional MongoDB nodes are added/removed from the stack.

## Requirements
* [x] **MongoDB**: version 6.0 and above (recipe uses `7.0.4`).
* [x] **PyMongo Driver**: 4.5.0 and above - *included* (image uses `4.6.1`).
* [x] **Docker**: tested on `24.0.7`.
* [x] **Operating System**: Linux (tested on `Ubuntu 23.04`). <br/>**[mongo-replica-ctrl](https://hub.docker.com/r/jackietreehorn/mongo-replica-ctrl)** image supports:
    `linux/amd64`, `linux/arm/v7`, `linux/arm64`

## Prerequisites
- A [Docker Swarm cluster](https://docs.docker.com/engine/swarm/swarm-tutorial/create-swarm/) (*locally or in the cloud as you prefer*) - tested on 6 node Swarm cluster.
- Docker Stack recipe - see [`docker-compose-stack.yml`](./docker-compose-stack.yml)
- Environment variables - see [`mongo-rs.env`](./mongo-rs.env)
- Deployment script [`deploy.sh`](./deploy.sh)

## How to Use

**TL;DR:**<br/>
- `git clone https://github.com/JackieTreeh0rn/MongoDB-ReplicaSet-Manager`
- `./deploy.sh`  
<br/> 
1. Ensure that all required environment variables are set in `mongo-rs.env` (see environment variables below). <br/>

2. Modify the `docker-compose-stack.yml` to add your main application making use of the mongo service.
**Note** - set your application's MongoDB URI to use the following connection string when connecting to the replica set service:<br/>

    `mongodb://${MONGO_ROOT_USERNAME}:${MONGO_ROOT_PASSWORD}@database:${MONGO_PORT:-27017}/?replicaSet=${REPLICASET_NAME}`
    

3. Deploy the compose stack on your Docker Swarm using the [`deploy.sh`](/deploy.sh) script via:
`sh deploy.sh` OR `./deploy.sh` - this will perform the following actions:<br/>
    - Import ENVironment variables.
    - Create **backend** 'overlay' network with encryption enabled.
    - Generate a `keyfile` for the replicaSet and add it as a Docker "secret" for the stack to use.
    - Spin-up the various docker stack services: mongo, dbcontroller, nosqlclient, your application or service.
    - The dbcontroller tool will run as a single instance per Swarm node (***global*** mode) as defined in the Compose YML. <br/>

4. Monitor logs for the tool's output and any potential errors or adjustments *(see troubleshooting section)* <br/>

5. To remove, run [`./remove.sh`](/remove.sh) or delete the stack manually via `docker stack rm [stackname]`. 
**Note:**  the `_backend` 'overlay' network created during initial deployment will not be removed automatically as it is considered external. If redeploying/updating, leave the existing network in place so as to retain the original network subnet.

## Environment Variables
The script requires the following environment variables, defined in `mongo-rs.env`:
* `STACK_NAME`, the default value is `myapp`
* `MONGO_VERSION`, the default value is `7.0.2`
* `REPLICASET_NAME`, the default value is `rs`
* `BACKEND_NETWORK_NAME`, the default value is `${STACK_NAME}_backend`
* `MONGO_SERVICE_URI`, the default value is `${STACK_NAME:}_database`
* `MONGO_ROOT_USERNAME`, the default value is `root`
* `MONGO_ROOT_PASSWORD`, the default value is `password123`
* `INITDB_DATABASE`, the default value is `myinitdatabase`
* `INITDB_USER`, the default value is `mydbuser`
* `INITDB_PASSWORD`, the default value is `password`


## How It Works
- The tool first identifies and assesses the status of MongoDB services in the Docker Swarm.
* It then either initializes a new MongoDB replica set or manages an existing one based on the current state.
- Continuous monitoring allows the tool to adapt the replica set configuration in response to changes in the Swarm network, such as node additions or removals, reboots, shutdowns, etc.
* The [nosqlclient](https://www.nosqlclient.com/) service included in the recipe can be used to access and manage the db - upon launching the nosqlclient front end, click connect to select a database to view/manage.
- The included compose YML will use the latest version available on DockerHub via [jackietreehorn/mongo-replica-ctrl](https://hub.docker.com/r/jackietreehorn/mongo-replica-ctrl)  . Alternatively, you can use `docker pull jackietreehorn/mongo-replica-ctrl:latest` to pull the latest version and push it onto your own repo.  Additionally, the included [`./build.sh`](/build.sh) allows you to build the docker image locally as well.

## Troubleshooting
* **Logs** - check the Docker service logs for the mongo controller service for details about its operation (enable `DEBUG:1` in compose YML if you want more detail).  
If you do not use something like [Portainer](https://docs.portainer.io/start/install-ce/server/swarm) or similar web frontend to manage Docker, you can follow the controller logs via CLI on one of your docker nodes via: `docker service logs [servicename]_dbcontroller --follow`

    Example:

    ```
    docker service logs symbot-coinbasepro_dbcontroller --follow --details
    ```

    ```| INFO:__main__:Checking Task IP: 10.0.26.48 for primary...
    | INFO:__main__:Expected number of mongodb nodes: {6} | Remaining to start: {0}
    | INFO:__main__:Mongo service nodes are up and running!
    | INFO:__main__:Mongo tasks ips: ['10.0.26.48', '10.0.26.52', '10.0.26.51', '10.0.26.49', '10.0.26.7', '10.0.26.4']
    | INFO:__main__:Inspecting Mongo nodes for pre-existing replicaset - this might take a few moments, please be patient...
    | INFO:__main__:Pre-existing replicaSet configuration found in node 10.0.26.48: {'10.0.26.52', '10.0.26.51', '10.0.26.49', '10.0.26.4', '10.0.26.7', '10.0.26.48'}
    | INFO:__main__:Checking Task IP: 10.0.26.52 for primary...
    | INFO:__main__:Checking Task IP: 10.0.26.51 for primary...
    | INFO:__main__:Checking Task IP: 10.0.26.7 for primary...
    | INFO:__main__:Checking Task IP: 10.0.26.48 for primary...
    | INFO:__main__:--> Mongo ReplicaSet Primary is: 10.0.26.48 <--

- **Environment** - verify that all required environment variables are correctly set in `mongo-rs.env`. 

* **YML** - ensure that the MongoDB service is correctly configured and accessible within the Docker Swarm - see compose file for standard configuration. The *dbcontroller* that maintains the status of the replica-set must be deployed in a single instance over a Swarm manager node (see [`docker-compose-stack.yml`](./docker-compose-stack.yml)).  **Multiple instances of the Controller, may perform conflicting actions!**  Also, to ensure that the controller is restarted in case of error, there is a restart policy in the controller service definition.

- **Persistent Data** - to use data persistence, the *mongo* service needs to be deployed in **global mode** (`docker-compose-stack.yml`). This is to avoid more than one instance being deployed on the same node and prevent different instances from concurrently accessing the same MongoDB data space on the filesystem.  The volumes defined in the compose YML allow for each mongo repplica to use its own dedicated data store.  They are also set as external so that they aren't inadvertenly deleted or recreated between service redeployments.

* **Swarm Nodes** - for HA purposes, your Swarm cluster should have more than one manager. This allows the *controller* to start/restart on different nodes in case of issues.

- **Healthchecks** - the Mongo **health check script** (`mongo-healthcheck`) serves only to verify the status of the MongoDB service. No check on mongo cluster status is made. The cluster status is checked and managed by the ***dbcontroller*** service. I use *Docker Configs* to pass the MongoDB health check script to the MongoDB containers - this is done automatically by Docker once the compose stack is deployed.

* **Networking** - the `_backend` 'overlay' external network created during initial deployment, is assigned an address space (eg. ***10.0.x.1***) automatically by Docker. You can define your own network space by uncommenting the relevant section in `deploy.sh` and adjusting as needed, in the event of overlap with other subnets in your network. In addition, **DO NOT** remove this network if planning to redeploy or update your stack on top of a existing/working replicaSet configuration so as to avoid connectivity issues between re-deployments.

- **MongoDB Configuration Check** - the Mongo [`/dbcontroller/docker-mongodb_config-check.sh`](./docker-mongodb_config-check.sh) script can be run from any docker node to locate and connect to a mongodb instance in the swarm and fetch configuration information.  It runs `rs.status()` and `rs.config()` and returns the output. This can help in validating/correlating the config's ***PRIMARY*** shown, against the **dbcontroller** logs, in addition to other relevant configuration information for your replicaSet.


    Example:

   ``````
   ./docker-mongodb_config-check.sh
   ``````


    ``````
    members: [
        {
        _id: 1,
        name: '10.0.26.51:27017',
        health: 1,
        state: 2,
        stateStr: 'SECONDARY',
        uptime: 20842,
        optime: { ts: Timestamp({ t: 1701196480, i: 1 }), t: Long("26") },
        optimeDurable: { ts: Timestamp({ t: 1701196480, i: 1 }), t: Long("26") },
        optimeDate: ISODate("2023-11-28T18:34:40.000Z"),
        optimeDurableDate: ISODate("2023-11-28T18:34:40.000Z"),
        lastAppliedWallTime: ISODate("2023-11-28T18:34:40.505Z"),
        lastDurableWallTime: ISODate("2023-11-28T18:34:40.505Z"),
        lastHeartbeat: ISODate("2023-11-28T18:34:54.484Z"),
        lastHeartbeatRecv: ISODate("2023-11-28T18:34:54.798Z"),
        pingMs: Long("6"),
        lastHeartbeatMessage: '',
        syncSourceHost: '10.0.26.52:27017',
        syncSourceId: 5,
        infoMessage: '',
        configVersion: 1521180,
        configTerm: 26
        },
        {
        _id: 2,
        name: '10.0.26.48:27017',
        health: 1,
        state: 1,
        stateStr: 'PRIMARY',     <-------------------------- SHOULD match log's outout for Primary
        uptime: 20843,
        optime: { ts: Timestamp({ t: 1701196480, i: 1 }), t: Long("26") },
        optimeDurable: { ts: Timestamp({ t: 1701196480, i: 1 }), t: Long("26") },
        optimeDate: ISODate("2023-11-28T18:34:40.000Z"),
        optimeDurableDate: ISODate("2023-11-28T18:34:40.000Z"),
        lastAppliedWallTime: ISODate("2023-11-28T18:34:40.505Z"),
        lastDurableWallTime: ISODate("2023-11-28T18:34:40.505Z"),
        lastHeartbeat: ISODate("2023-11-28T18:34:54.698Z"),
        lastHeartbeatRecv: ISODate("2023-11-28T18:34:55.156Z"),
        pingMs: Long("8"),
        lastHeartbeatMessage: '',
        syncSourceHost: '',
        syncSourceId: -1,
        infoMessage: '',
        electionTime: Timestamp({ t: 1701152367, i: 1 }),
        electionDate: ISODate("2023-11-28T06:19:27.000Z"),
        configVersion: 1521180,
        configTerm: 26
        }
    ``````

- **Start-up Issues**  - please note that depending on the number of nodes in your swarm and your connection speed, it might take some time for images to download, for the mongodb instances to spin up, and the replica manager to configure the replica-set. Services in the compose stack YML recipe, such as `MongoExpress` and `SymBot` itself, that depend on the mongo database to be operational, might fail/restart at first (*particularly upon an initial/blank-slate deployment*) before showing as **READY**  - this **is** normal for initial deployments and services will attempt to connect to mongo again upon restarts - MongoDB operating in replicaset mode will not become available for use until the replicaset configuration is finalized and a primary instance is elected.

## Contact
- Røb
    - Mail: jackietreehorn01@protonmail.com
    - Discord: discordapp.com/users/916819244048592936
    - GitHub: github.com/jackietreeh0rn
    - DockerHub: hub.docker.com/u/jackietreehorn
