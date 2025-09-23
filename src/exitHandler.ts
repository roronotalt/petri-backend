import { pubClient } from "./kassspay-connections/pubsub";

export const exitHandler = (
    options: {
        cleanup?: boolean;
        exit?: boolean;
    },
    exitCode: number
) => {
    if (pubClient.isOpen) {
        pubClient.del(`server_heartbeat_${process.env.SERVER_UUID}`);
    }
};

// do something when app is closing
process.on("exit", exitHandler.bind(null, { cleanup: true }));

// catches ctrl+c event
process.on("SIGINT", exitHandler.bind(null, { exit: true }));

// catches "kill pid" (for example: nodemon restart)
process.on("SIGUSR1", exitHandler.bind(null, { exit: true }));
process.on("SIGUSR2", exitHandler.bind(null, { exit: true }));

// catches uncaught exceptions
process.on("uncaughtException", exitHandler.bind(null, { exit: true }));
