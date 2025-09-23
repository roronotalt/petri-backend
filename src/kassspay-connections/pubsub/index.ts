import { createClient } from "redis";

export const subClient = createClient({ url: process.env.REDIS_URL });
export const pubClient = createClient({ url: process.env.REDIS_URL });
subClient.on("error", (err: any) => console.log("Redis Client Error", err));

const connectRedis = async (): Promise<void> => {
    await subClient.connect();
    await pubClient.connect();
};

subClient.on("error", (err: Error) => {
    console.error("Redis sub client connection error:", err);
});

pubClient.on("error", (err: Error) => {
    console.error("Redis pub client connection error:", err);
});

connectRedis().catch(console.error);
