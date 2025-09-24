/**
 * This file is used to handle the election of a server leader.
 * the leader is the first server to connect to the pubsub server.
 * if the leader dies, the next server to connect to the pubsub server will become the leader.
 * the leader is responsible for handling updates relating to the key.
 */
import { pubClient } from "./petri-connections/pubsub";

const server_uuid = process.env.SERVER_UUID;
if (!server_uuid) {
    throw new Error("SERVER_UUID is not set");
}

setInterval(async () => {
    await pubClient.set(
        `server_heartbeat_${server_uuid}`,
        Date.now().toString()
    );
}, 1000);

export const election = async (
    key: string
): Promise<{
    leader: boolean;
}> => {
    // check if current leader is alive
    const current_leader = await pubClient.get(`election_leader_${key}`);
    if (current_leader) {
        const current_leader_heartbeat = await pubClient.get(
            `server_heartbeat_${current_leader}`
        );
        if (
            !current_leader_heartbeat ||
            Date.now() - parseInt(current_leader_heartbeat) > 5000
        ) {
            await Promise.all([
                pubClient.set(`election_leader_${key}`, server_uuid),
                pubClient.del(`server_heartbeat_${current_leader}`),
            ]);
            return { leader: true };
        }

        // leader is alive
        return { leader: false };
    }

    // no leader
    await pubClient.set(`election_leader_${key}`, server_uuid);
    return { leader: true };
};

export const quitBeingLeader = async (key: string) => {
    await pubClient.del(`election_leader_${key}`);
};
