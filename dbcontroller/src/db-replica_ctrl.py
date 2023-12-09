"""
AUTHOR: 
    R0b
    jackietreehorn01@protonmail.com
    https://github.com/JackieTreeh0rn/MongoDB-ReplicaSet-Manager

NAME: 
    MongoDB ReplicaSet Manager for Docker Swarm

VERSION: 
    1.01

DESCRIPTION:
    This script is used to configure, initiate, monitor, and maintain a MongoDB replicaset on a Docker Swarm

REQUIREMENTS:
    - MongoDB >= 6.0 - using 7.0.4
    - PyMongo Driver >= 4.5.0 - using 4.6.1
    - ENV variables

IMPORTANT: 
    1. It is intended to be used with a docker-stack-compose.yml with a mongodb replica recipe.
    2. There should not be more than one process running this script in the swarm -  1 db controller instance per Stack.
    2. There should be maximum of one replica of MongoDB per swarm node. This is achieved using "global" deployment mode in composer YML for mongo.

HOW IT WORKS / FEATURES:
    1. Scans running mongod instances in the swarm, 
        - Determines # of nodes in the mongo global service to wait for
        - Takes into account 'down' nodes or nodes marked as 'unvailable'/'drain'
    2. Checks if a replicaset is already configured
    3. If configured:
        - Searches and loads replicaset configuration
        - If the old replicaset lost the primary node, waits for a new election. In lack of a new primary, it forces a reconfiguration
        - If it determines there has been a re-deployment (service update/re-stacking) it reconfigures the replica set accordingly
    4. If not configured:
        - Picks an arbitrary instance to act as a replicaset primary (first container/IP)
        - Configures and initiates the replicaset
        - Creates admin user (root) user for mongodb replica
        - Creates a new initial db user & db for an initial db to be used by your main application
    5. Monitors - keeps listening for changes in the original replicaset of mongod instances IPs
    6. Reconfigures replicaset if a change was perceived
        - add/remove members as needed
        - reinitiates a primary member if lost

INPUT: 
    via environment variables. See get_required_env_variables.
    
USAGE: 
    1. Use build.sh to build controller image OR use provided docker image jackietreehorn/db-replica-ctrl:latest
    2. Deploy your composer YML stack via deploy.sh to import .env variables and deploy your application YML 
"""

from pymongo.errors import PyMongoError, OperationFailure, ServerSelectionTimeoutError
import docker
from contextlib import contextmanager
import logging
import traceback
import os
import pymongo as pm
import sys
import time
import json
import backoff


# Added my own Docker context manager since it isn't supported natively in the Docker SDK (helps in closing client sessions)
@contextmanager
def docker_client():
    client = docker.from_env()
    try:
        yield client
    finally:
        client.close()


def get_required_env_variables():
    REQUIRED_VARS = [
        'OVERLAY_NETWORK_NAME',
        'MONGO_SERVICE_NAME',
        'REPLICASET_NAME',
        'MONGO_PORT',
        'MONGO_ROOT_USERNAME',
        'MONGO_ROOT_PASSWORD',
        'INITDB_DATABASE',
        'INITDB_USER',
        'INITDB_PASSWORD'
    ]
    envs = {}
    for rv in REQUIRED_VARS:
        found = False
        for env_var in os.environ:
            if env_var.lower() == rv.lower():
                envs[rv.lower()] = os.environ[env_var]
                found = True
                break
        if not found:
            envs[rv.lower()] = None

    if not all(value is not None for value in envs.values()):
        missing_vars = [var for var, value in envs.items() if value is None]
        raise RuntimeError(f"Missing required ENV variables: {missing_vars}")

    envs['mongo_port'] = int(envs['mongo_port']) if envs['mongo_port'] is not None else None

    return envs


def get_mongo_service(dc, mongo_service_name):
    mongo_services = [s for s in dc.services.list() if s.name == mongo_service_name]
    if len(mongo_services) > 1:
        raise RuntimeError(f"Unexpected: multiple docker services with the name '{mongo_service_name}' found: {mongo_services}")

    if not mongo_services:
        raise RuntimeError(f"Error: Could not find mongo service with name {mongo_service_name}. "
                           "Did you correctly deploy the stack with the right service?")

    return mongo_services[0]


def is_service_up(mongo_service):
    """
    Check if the MongoDB service is up and running.

    This function will compare the number of running tasks with the expected number of replicas.
    It will return True if all replicas are running, False otherwise.
    It will take into account swarm nodes that are unavailable (drain) as well as (down) nodes.

    :param mongo_service: The MongoDB service object.
    :return: Boolean indicating whether the service is fully up and running.
    """

    if mongo_service is None:
        return False

    running_tasks_count = len(get_running_tasks(mongo_service))

    # Get the expected number of replicas from the service mode
    mode = mongo_service.attrs['Spec']['Mode']
    if 'Replicated' in mode:
        expected_replicas = mode['Replicated']['Replicas']
    elif 'Global' in mode:
        # For 'Global' mode, count the number of ready and active active nodes in swarm
        dc = docker.from_env()
        nodes = dc.nodes.list()
        active_nodes = [node for node in nodes if node.attrs['Spec']['Availability'] == 'active' and node.attrs['Status']['State'] != 'down']
        expected_replicas = len(active_nodes)
        logger.info("Expected number of mongodb nodes: {} | Remaining to start: {}".format({expected_replicas},{expected_replicas - running_tasks_count}))
    else:
        return False
    dc.close()
    return running_tasks_count == expected_replicas


@backoff.on_exception(backoff.expo, docker.errors.APIError, max_tries=10)
def get_running_tasks(mongo_service, desired_state="running"):
    tasks = []
    for t in mongo_service.tasks(filters={'desired-state': desired_state}):
        if t['Status']['State'] == desired_state:
            tasks.append(t)
    return tasks


def get_tasks_ips(tasks, overlay_network_name):
    tasks_ips = []
    for t in tasks:
        for n in t['NetworksAttachments']:
            if n['Network']['Spec']['Name'] == overlay_network_name:
                ip = n['Addresses'][0].split('/')[0]  # clean prefix from ip
                tasks_ips.append(ip)
    return tasks_ips


def setup_initial_database(current_member_ips, mongo_port, mongo_root_username, mongo_root_password, initdb_database, initdb_user, initdb_password):
    """
    Sets up the initial database with a user and an entry in the users collection.
    
    :param primary_ip: The container object of the primary MongoDB instance.
    :param mongo_port: Port on which MongoDB is running.
    :param initdb_database: The name of the database to use or create.
    :param initdb_user: The username for the new user.
    :param initdb_password: The password for the new user.
    """
    logger = logging.getLogger(__name__)

    primary_ip = get_primary_ip(current_member_ips, mongo_port, mongo_root_username, mongo_root_password)
    if primary_ip is None:
        logger.error("No primary MongoDB instance found. Initial user/database setup cannot be completed!")
        return

    # Connect to the primary node
    client = pm.MongoClient(
        host=primary_ip,
        port=mongo_port,
        username=mongo_root_username,
        password=mongo_root_password,
        authSource='admin',
        directConnection=True,
        serverSelectionTimeoutMS=15000,  # 15 seconds timeout server selection
        connectTimeoutMS=30000,  # 30 seconds connection timeout
        socketTimeoutMS=30000    # 30 seconds socket operation timeout
    )

    try:
        logger.info(f"Attempting to create initial user {initdb_user} in initial db {initdb_database} ...")
        # Select the database
        db = client[initdb_database]
        logger.info(f"Selected the {initdb_database} database on {primary_ip}")

        # Create the user with dbOwner role
        logger.info(f"Creating user '{initdb_user}' with dbOwner role.")
        db.command("createUser", initdb_user, pwd=initdb_password, roles=["dbOwner"])
        logger.info(f"User '{initdb_user}' created successfully!")

        # Insert a document into the 'users' collection
        logger.info(f"Inserting document into the 'users' collection for user '{initdb_user}'.")
        db.users.insert_one({"name": initdb_user})
        logger.info(f"Document for user '{initdb_user}' inserted successfully!")
        logger.info("Initial database and initial user setup completed!")

    except Exception as e:
        if hasattr(e, 'code') and e.code == 51003:  # user already exists
            logger.info(f"User '{initdb_user}' already exists in database '{initdb_database}'. No action needed.")
        else:
            logger.error(f"An error occurred while setting up the initial database: {e}")
    
    finally:
        client.close()


def init_replica(mongo_tasks, mongo_tasks_ips, replicaset_name, mongo_port, mongo_root_username, mongo_root_password, retry_attempts=4, retry_delay=10):
    """
    Init a MongoDB replicaset from the scratch.
    """
    logger = logging.getLogger(__name__)

    # Initial checks for MongoDB task IDs or IPs
    for attempt in range(retry_attempts):
        if not mongo_tasks or not mongo_tasks_ips:
            logger.warning(f"No MongoDB task IDs or IPs found. Retry attempt {attempt + 1}/{retry_attempts}.")
            time.sleep(retry_delay)
        else:
            break
    else:
        logger.error("No MongoDB task IDs or IPs found after all retry attempts. Cannot initialize replica!")
        return

    logger.debug("List of MongoDB task IPs: {}".format(mongo_tasks_ips))
    for task, task_ip in zip(mongo_tasks, mongo_tasks_ips):
        task_id = task['ID']
        task_status = task['Status']['State']
        task_container_id = task['Status']['ContainerStatus']['ContainerID']
        logger.debug("Task ID: {}, Status: {}, Container ID: {}, IP: {}".format(task_id, task_status, task_container_id, task_ip))

    config = create_mongo_config(mongo_tasks_ips, replicaset_name, mongo_port)
    config_str = json.dumps(config)  # Serialize config to json formatted string
    logger.debug("Initial config Built: {}".format(config))

    primary_ip = list(mongo_tasks_ips)[0]

    # Choose a primary and configure replicaset (picking first IP | first docker container)
    time.sleep(15)
    try:
        with docker_client() as dc:
            # Get the first MongoDB container
            mongoContainer = next((c for c in dc.containers.list() if c.name.split('.')[0] == mongo_service_name), None)
            if not mongoContainer:
                logger.error("No MongoDB containers found in the Docker swarm.")
                return
            
            # Initialize replica set on localhost using docker
            initCommand = f"rs.initiate({config_str});"
            clusterCreateExecRes = mongoContainer.exec_run(f"mongosh --quiet --eval '{initCommand}'")
            if clusterCreateExecRes.exit_code != 0:
                raise PyMongoError(clusterCreateExecRes.output.decode())
            logger.info("Creating initial ReplicaSet - result: {}".format(clusterCreateExecRes))
    except PyMongoError as e:
            error_message = str(e)
            if "replSetInitiate requires authentication" in error_message:
                # Handle re-deployment scenario
                logger.info("Re-deployment detected - forcing re-configuration...")
                reconfigure_replica_set(primary_ip, mongo_port, mongo_root_username, mongo_root_password, config, logger)
            elif "No primary detected" in error_message or "Invalid replica set" in error_message:
                logger.error(f"Replica set error: {error_message}")
                # Optional: Implement logic to recover from this state
            else:
                logger.error(f"Failed to initiate replica set: {error_message}")


    # TODO: switch initiation to pyMongo method (in work)
    # primary = pm.MongoClient(host=primary_ip, port=mongo_port, username=mongo_root_username, password=mongo_root_password, directConnection=True) #added direcConnection per pymongo doc
    # try:
    #     res = primary.admin.command("replSetInitiate", config)
    # except OperationFailure as e:
    #     logger.debug("replSetInitiate already configured, forcing configuration ({})".format(e))
    #     res = primary.admin.command("replSetReconfig", config, force=True)
    # finally:
    #     # added change stream as per recommendation for MongoDB > 6 - not using
    #     set_change_stream_options(primary, expire_after_seconds=100)  # set expireAfterSeconds to 100 seconds
    #     primary.close()
    # logger.info("replSetInitiate: {}".format(res))


    # Initialize mongodb admin, initial db user in initial db
    initialize_mongodb_admin(mongo_tasks, primary_ip, mongo_port, mongo_root_username, mongo_root_password, logger, dc)


def reconfigure_replica_set(primary_ip, mongo_port, mongo_root_username, mongo_root_password, config, logger):
    """
    Reconfigure the MongoDB replica set in case of re-deployment.
    """

    # LEGACY method via containers - (deprecating)
    # Re-deployment detected, using rs.reconfig to reconfigure replicaset
    # authCommand = f"db.getSiblingDB('admin').auth('{mongo_root_username}', '{mongo_root_password}');"
    # reconfigCommand = f"rs.reconfig({config}, {{force: true}});"
    # fullCommand = authCommand + reconfigCommand
    # reconfigExecRes = mongoContainer.exec_run(f"mongosh --quiet --eval \"{fullCommand}\"")
    # logger.info("Attempted replicaSet re-configuration - result: {}".format(reconfigExecRes))

    try:
        primary = pm.MongoClient(
            host=primary_ip, 
            port=mongo_port, 
            username=mongo_root_username, 
            password=mongo_root_password,
            directConnection=True,
            serverSelectionTimeoutMS=15000,
            connectTimeoutMS=30000,
            socketTimeoutMS=30000
        )
        res = primary.admin.command("replSetReconfig", config, force=True)
        logger.info("Reconfiguring ReplicaSet - result: {}".format(res))
    except OperationFailure as opfail:
        logger.debug("replSetReconfig error: ({})".format(opfail))
    finally:
        primary.close()


def initialize_mongodb_admin(mongo_tasks, primary_ip, mongo_port, mongo_root_username, mongo_root_password, logger, dc):
    """
    Initialize MongoDB admin by checking which container is primary, then create root account.
    """

    logger.info("Configuring mongodb admin...")
    time.sleep(35)  # Wait for config reconciliation & proper docker container identification
    try:
        primaryNoAuth = pm.MongoClient(
            host=primary_ip,
            port=mongo_port,
            directConnection=True,  # Mongo > 4 defaults to 'false' which forces discovery instead of direct interrogation - this always returns writeablePrimary=true on all 
            serverSelectionTimeoutMS=15000, # 15 seconds timeout server selection
            connectTimeoutMS=30000,  # 30 seconds connection timeout
            socketTimeoutMS=30000  # 30 seconds socket operation timeout
        )
        replicaSetTopology = primaryNoAuth.admin.command('hello')  # 'hello' command pulls topology
        logger.debug("ReplicaSet Topology: {}".format(replicaSetTopology))

        primaryIp = replicaSetTopology["primary"].split(':')[0] if replicaSetTopology["primary"] else None
        if primaryIp is None:
            logger.error("Initializing Admin - Primary IP not found in replica set topology")
            return
    except Exception as e:
        logger.error(f"Error while getting primary IP from Topology: {e} - could not complete replicaset admin initilization!")
        return
    finally:
        primaryNoAuth.close()

    containerId = next((c["Status"]["ContainerStatus"]["ContainerID"] for c in mongo_tasks if c["NetworksAttachments"][0]["Addresses"][0].split('/')[0] == primaryIp), None)
    if containerId:
        create_mongodb_root_user(containerId, mongo_root_username, mongo_root_password, logger, dc, primaryIp)
    else:
        logger.error("No container found for the primary IP: {}".format(primaryIp))


def create_mongodb_root_user(containerId, mongo_root_username, mongo_root_password, logger, dc, primaryIp):
    """
    Create MongoDB root user on the primary container.
    """
    logger.info(f"Creating mongo admin user on primary container...")
    try:
        primaryContainer = dc.containers.get(containerId)
        logger.debug("Found primary container: {} and primary ip: {} in topology".format(primaryContainer, primaryIp))
        createAdmin = "admin = db.getSiblingDB('admin'); admin.createUser({ user: '%s', pwd: '%s', roles: [ 'root' ] } );" % (mongo_root_username, mongo_root_password)
        adminCreateExecRes = primaryContainer.exec_run("mongosh --quiet --eval \"%s\"" % (createAdmin))

        if adminCreateExecRes.exit_code == 0:
            logger.info("Root user created successfully.")
        elif "Command createUser requires authentication" in adminCreateExecRes.output.decode():
            logger.info(f"Root user '{mongo_root_username}' already exists - skipping admin user creation.")
        else:
            logger.error(f"Failed to create root user: {adminCreateExecRes.output.decode()}")
    except PyMongoError as e:
        logger.error(f"MongoDB error occurred: {e}")
    except docker.errors.NullResource:
        logger.error(f"Could not find container with ID {containerId}")
    except Exception as e:
        logger.error(f"Unexpected error creating root user: {e}")


def create_mongo_config(tasks_ips, replicaset_name, mongo_port):
    members = []
    for i, ip in enumerate(tasks_ips):
        members.append({
          '_id': i,
          'host': "{}:{}".format(ip, mongo_port)
        })
    config = {
        '_id': replicaset_name,
        'members': members,
        'version': 1
        # 'term': 1  # Mongo manages 'term' automatically for config
    }
    # Logging outcome
    logger.info(f"Building MongoDB config with {len(tasks_ips)} members.")
    return config


def gather_configured_members_ips(mongo_tasks_ips, mongo_port, mongo_root_username, mongo_root_password):
    logger = logging.getLogger(__name__)
    current_ips = set()
    config_found = False

    logger.info("Inspecting Mongo nodes for pre-existing replicaset - this might take a few moments, please be patient...")
    for t in mongo_tasks_ips:
        mc = pm.MongoClient(
            host=t, 
            port=mongo_port,
            directConnection=True, # Mongo > 4 defaults to 'false' which forces discovery instead of direct interrogation - this always returns writeablePrimary=true on all 
            username=mongo_root_username, 
            password=mongo_root_password, 
            authSource='admin', 
            serverSelectionTimeoutMS=15000,  # 15 seconds timeout server selection
            connectTimeoutMS=30000,  # 30 seconds connection timeout
            socketTimeoutMS=30000    # 30 seconds socket operation timeout
            )
        try:
            config = mc.admin.command("replSetGetConfig")['config']
            for m in config['members']:
                current_ips.add(m['host'].split(":")[0])
            config_found = True
            logger.info("Pre-existing replicaSet configuration found in node {}: {}".format(t, current_ips))
            break
        except pm.errors.ServerSelectionTimeoutError as ssete:
            logger.debug(f"No pre-existing replicaSet configuration found in node {t} -- (Possible NEW build - please wait...) - ({ssete})")
        except pm.errors.OperationFailure as of:
            logger.debug(f"Operation failed on node {t} ({of})")
        finally:
            mc.close()

    if not config_found:
        logger.info("No pre-existing configuration found across all nodes")
        return current_ips # Return the empty set of IPs

    logger.debug(f"Current replicaSet members in mongo configuration: {current_ips}")
    return current_ips  # Return the current set of IPs


def get_primary_ip(tasks_ips, mongo_port, mongo_root_username, mongo_root_password):
    logger = logging.getLogger(__name__)

    primary_ips = []
    for t in tasks_ips:
        mc = pm.MongoClient(
            host=t, 
            port=mongo_port, 
            username=mongo_root_username, 
            password=mongo_root_password,
            authSource='admin',
            directConnection=True, # Mongo > 4 defaults to 'false' which forces discovery instead of direct interrogation - this always returns writeablePrimary=true on all members (multiple primaries issue)
            serverSelectionTimeoutMS=15000,  # 15 seconds timeout for server selection
            connectTimeoutMS=30000,  # 30 seconds connection timeout
            socketTimeoutMS=30000    # 30 seconds socket operation timeout
        )
        logger.info("Checking Task IP: {} for primary...".format(t))
        try:
            if mc.is_primary:
                primary_ips.append(t)
        except ServerSelectionTimeoutError as ssete:
            logger.debug("Cannot connect to {} to check for primary: ({})".format(t,ssete))
        except OperationFailure as of:
            logger.debug("No replicaSet primary IP configuration found in node {} : ({})".format(t,of))
        finally:
            mc.close()

    if len(primary_ips) > 1:
        logger.warning("Multiple primaries were found ({}). Let's use the first".format(primary_ips))
        ## NOTE: tentative step_down_primary method for multilple primary IPs found (shouldn't happen if setup properly with directConnection parameter)
        # step_down_primary(current_primary_ip, mongo_port, mongo_root_username, mongo_root_password)

    if primary_ips:
        logger.info("--> Mongo ReplicaSet Primary is: {} <--".format(primary_ips[0]))
        return primary_ips[0]


# NOTE: alternate get_primary_ip method - not using
# def get_primary_ip(tasks_ips, mongo_port, mongo_root_username, mongo_root_password):
#     logger = logging.getLogger(__name__)
#     primary_ip = None
#     for t in tasks_ips:
#         mc = pm.MongoClient(
#             host=t,
#             port=mongo_port,
#             username=mongo_root_username,
#             password=mongo_root_password,
#             directConnection=True,
#             serverSelectionTimeoutMS=9000  # 9 seconds timeout
#         )
#         try:
#             # Use the 'hello' command to ensure we get the latest information
#             server_status = mc.admin.command('hello')
#             if server_status.get('isWritablePrimary', False):
#                 primary_ip = t
#                 break  # We found the primary, no need to continue
#         except ServerSelectionTimeoutError as ssete:
#             logger.debug(f"Cannot connect to {t} to check if primary, failed ({ssete})")
#         except OperationFailure as of:
#             logger.debug(f"No configuration found in node {t} ({of})")
#         finally:
#             mc.close()

#     if primary_ip:
#         logger.info(f"Primary is: {primary_ip}")
#     else:
#         logger.warning("No primary found in the given task IPs.")
#     return primary_ip


def update_config(primary_ip, current_ips, new_ips, mongo_port, mongo_root_username, mongo_root_password):

    logger = logging.getLogger(__name__)

    to_remove = set(current_ips) - set(new_ips)
    to_add = set(new_ips) - set(current_ips)

    if not (to_remove or to_add) and current_ips:
        logger.info("Config update - no IP changes to add/remove")
        force = True
    else:
        assert to_remove or to_add
        force = False

    # Force reconfiguration when significant changes are detected
    force = len(to_remove) > 1 or len(to_add) > 1

    if primary_ip in to_remove or primary_ip is None:
        logger.info("Config update - Primary ({}) no longer available".format(primary_ip))
        force = True

        # Let's see if a new primary was elected
        attempts = 3
        primary_ip = None
        while attempts and not primary_ip:
            time.sleep(10)
            primary_ip = get_primary_ip(list(new_ips), mongo_port, mongo_root_username, mongo_root_password)
            attempts -= 1
            logger.info("Config update - No new primary yet automatically elected, please wait..".format(primary_ip))

        if primary_ip is None:
            old_members = list(new_ips - to_add)
            primary_ip = old_members[0] if old_members else list(new_ips)[0]
            logger.info("Config update - Choosing {} as the new primary".format(primary_ip))

    cli = pm.MongoClient(
        host=primary_ip, 
        port=mongo_port,
        directConnection=True,
        username=mongo_root_username, 
        password=mongo_root_password, 
        authSource='admin',
        serverSelectionTimeoutMS=15000,  # 15 seconds timeout server selection
        connectTimeoutMS=30000,  # 30 seconds connection timeout
        socketTimeoutMS=30000    # 30 seconds socket operation timeout
        )
    try:
        config = cli.admin.command("replSetGetConfig")['config']
        logger.debug("Config Update - Old replica Members: {}".format(config['members']))

        if to_remove:
            logger.info("Config Update - Replica members to remove: {}".format(to_remove))
            new_members = [m for m in config['members'] if m['host'].split(":")[0] not in to_remove]
            config['members'] = new_members

        if to_add:
            logger.info("Config Update - Replica members to add: {}".format(to_add))
            if config['members']:
                offset = max([m['_id'] for m in config['members']]) + 1
            else:
                offset = 0

            for i, ip in enumerate(to_add):
                config['members'].append({
                    '_id': offset + i,
                    'host': "{}:{}".format(ip, mongo_port, mongo_root_username, mongo_root_password)
                })

        # Incrementing 'version' - 'term' automatically incremented by mongo
        config['version'] += 1
        
        logger.debug("Config Update - Built Updated config: {}".format(config))

        # Apply new config
        res = cli.admin.command("replSetReconfig", config, force=force)
        logger.info("Config Update - Applied Updated Config - result: {}".format(res))

    except ServerSelectionTimeoutError as e:
        logger.error(f"Config Update - Failed to connect to MongoDB for reconfiguration: {e}")

    except PyMongoError as e:
        logger.error(f"Config Update - MongoDB error occurred during reconfiguration: {e}")
        logger.error(f"Error details: Code: {e.code}, Details: {e.details}")

    except Exception as e:
        logger.error(f"Config Update - General exception occurred during reconfiguration: {e}")
        logger.error(f"Exception traceback: {traceback.format_exc()}")

    finally:
        cli.close()


# NOTE: tentative method for stepping down primaries, not needed or using so far
# def step_down_primary(primary_ip, mongo_port, mongo_root_username, mongo_root_password):
#     logger = logging.getLogger(__name__)
#     with pm.MongoClient(host=primary_ip, port=mongo_port, username=mongo_root_username, password=mongo_root_password) as primary:
#         try:
#             result = primary.admin.command("replSetStepDown")
#             logger.info(f"Step-down result: {result}")
#         except Exception as e:
#             logger.error(f"Failed to step down primary ({primary_ip}): {str(e)}")


# NOTE: method to add changeStreamOptions, per Mongo > 6 recommendation - not using (defaults work)
# def set_change_stream_options(client, expire_after_seconds=None):
#     """
#     Set the changeStreamOptions parameter on the MongoDB cluster.
#     :param client: pymongo.MongoClient, connected to the primary node.
#     :param expire_after_seconds: int, the time in seconds after which the change stream events expire.
#     """
#     command = {
#         "setClusterParameter": {
#             "changeStreamOptions": {
#                 "preAndPostImages": {
#                     "expireAfterSeconds": expire_after_seconds
#                 }
#             }
#         }
#     }
#     try:
#         result = client.admin.command(command)
#         logging.info(f'Set changeStreamOptions: {result}')
#     except Exception as e:
#         logging.error(f'Failed to set changeStreamOptions: {str(e)}')


# NOTE: method to adjust election timeout - not using (defaults work)
# def adjust_election_timeout(primary_ip, mongo_port, mongo_root_username, mongo_root_password):
#     """
#     Adjust the election timeout and heartbeat settings.
#     """
#     logger = logging.getLogger(__name__)
#     with pm.MongoClient(host=primary_ip, port=mongo_port, username=mongo_root_username, password=mongo_root_password) as client:
#         try:
#             config = client.admin.command("replSetGetConfig")
#             config['config']['settings'] = {'electionTimeoutMillis': 10000,  # Adjust as needed
#                                             'heartbeatTimeoutSecs': 10}  # Adjust as needed
#             client.admin.command("replSetReconfig", config['config'])
#         except Exception as e:
#             logger.error(f"Failed to adjust election timeout: {str(e)}")


def manage_replica(mongo_service, overlay_network_name, replicaset_name, mongo_port, mongo_root_username, mongo_root_password, initdb_database, initdb_user, initdb_password):
    """
    To manage the replica is to:
    - Configure replicaset
        If there was no replica before, create one from scratch.
        If there was a replica (e.g, this script was restarted), that replicaset could be either fine or broken.
            If the replicaset was healthy, move on to the "watching" phase.
            Else, force a reconfiguration.
    - Watch for changes in tasks ips
        When IP changes are detected, the replica will break, so we must fix it on the fly.

    :param mongo_service:
    :param overlay_network_name:
    :param replicaset_name:
    :param mongo_port:
    :return:
    """
    logger = logging.getLogger(__name__)

    # Get mongo tasks ips
    mongo_tasks = get_running_tasks(mongo_service)
    mongo_tasks_ips = get_tasks_ips(mongo_tasks, overlay_network_name)
    logger.info("Mongo tasks ips: {}".format(mongo_tasks_ips))

    current_member_ips = gather_configured_members_ips(mongo_tasks_ips, mongo_port, mongo_root_username, mongo_root_password)
    logger.debug("Current mongo ips in returned configuration: {}".format(current_member_ips))
    primary_ip = get_primary_ip(current_member_ips, mongo_port, mongo_root_username, mongo_root_password)
    logger.debug("Current primary ip in returned configuration: {}".format(primary_ip))

    if len(current_member_ips) == 0:
        # Starting from the scratch or a fresh deployment
        logger.info("No previous replicaSet configuration found - checking if re-deployment or building from scratch...")
        current_member_ips = set(mongo_tasks_ips)
        init_replica(mongo_tasks, current_member_ips, replicaset_name, mongo_port, mongo_root_username, mongo_root_password)
        setup_initial_database(current_member_ips, mongo_port, mongo_root_username, mongo_root_password, initdb_database, initdb_user, initdb_password)

    # Watch for IP changes. If IPs remain stable we assume MongoDB maintains the replicaset working fine.
    while True:
        time.sleep(10)
        new_member_ips = set(get_tasks_ips(get_running_tasks(mongo_service), overlay_network_name))
        if current_member_ips.symmetric_difference(new_member_ips):
            logger.info("Detected change in member IPs - Updating configuration...")
            update_config(primary_ip, current_member_ips, new_member_ips, mongo_port, mongo_root_username, mongo_root_password)
        current_member_ips = new_member_ips
        primary_ip = get_primary_ip(new_member_ips, mongo_port, mongo_root_username, mongo_root_password)


if __name__ == '__main__':
    # Get environment variables
    envs = get_required_env_variables()
    mongo_service_name = envs.pop('mongo_service_name')

    if '1' == os.environ.get('DEBUG'):
        logging.basicConfig(level=logging.DEBUG)
    else:
        logging.basicConfig(level=logging.INFO)

    # Set logging of HTTP entries to WARNING-level only
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    # Set logging for docker.utils.config to WARNING-level only
    logging.getLogger("docker.utils.config").setLevel(logging.WARNING)

    logger = logging.getLogger(__name__)

    try:
        with docker_client() as dc:
            logger.info('Waiting for mongo service ({}) tasks to start, please be patient...'.format(mongo_service_name))

            # Make sure Mongo is up and running
            attempts = 30  # Total number of attempts to check if the service is up - increase for large # of nodes (tested on 6 nodes)
            mongo_service = None
            service_down = True
            while service_down and attempts > 0:
                logger.info("Waiting for all MongoDB replicas to be up - attempts remaining: {}".format(attempts))
                time.sleep(10)  # Check every 10 seconds
                mongo_service = get_mongo_service(dc, mongo_service_name)
                service_down = not is_service_up(mongo_service)
                attempts -= 1

            if attempts <= 0 or not mongo_service:
                logger.error('Exhausted attempts waiting for mongo service ({}) - restarting task...'.format(mongo_service_name))
                sys.exit(1)

            logger.info("Mongo service nodes are up and running!")
            manage_replica(mongo_service, **envs)
    
    except docker.errors.DockerException as e:
        logger.error(f"An error occurred with Docker: {e}")
        sys.exit(1)
