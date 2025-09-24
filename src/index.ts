import dotenv from "dotenv";
import { z } from "zod";
import {
    Kparse,
    Kstringify,
    KSupportedDeveloperNetworks,
    KSupportedMainNetworks,
    KAddressKindToNetworks,
    KSupportedNetworks,
    KWebsocketMethods,
} from "@kasssandra/kassspay";
import { db } from "./petri-connections/database";
import { inArray, type InferSelectModel } from "drizzle-orm";
import { exitHandler } from "./exitHandler";
import {
    pubsubWebsocketSubscribe,
    SubscriptionType,
    type WebSocketHandler,
} from "./stores";
import { subClient } from "./petri-connections/pubsub";
import { quitBeingLeader } from "./elections";

dotenv.config();
exitHandler;

const walletUpdatesSchema = z.object({
    wallet_id: z.number().int().nonnegative(),
});

const serverZodSchema = z.discriminatedUnion("method", [
    z.object({
        id: z.string().max(100),
        method: z.enum(KWebsocketMethods),
        params: walletUpdatesSchema,
    }),
]);

Bun.serve({
    fetch(req, server) {
        if (
            server.upgrade(req, {
                data: {
                    active: true,
                    subscriptions: new Map(),
                    window_open: true,
                },
            })
        ) {
            return;
        }

        return new Response("Not found", {
            status: 404,
            headers: {
                "Content-Type": "text/plain",
            },
        });
    },
    websocket: {
        async message(ws: WebSocketHandler, message) {
            let parsed: z.infer<typeof serverZodSchema>;
            try {
                const result = serverZodSchema.safeParse(
                    Kparse(message.toString())
                );
                if (!result.success) {
                    ws.send(
                        Kstringify({
                            error: result.error.issues[0]?.message,
                            code: 400,
                        })
                    );
                    return;
                }
                parsed = result.data;
            } catch (e) {
                ws.send(
                    Kstringify({
                        error: "Kparse failed, make sure you are using Kstringify",
                        code: 400,
                    })
                );
                return;
            }

            switch (parsed.method) {
                case "wallet_updates":
                    break;
            }
        },
        open(ws: WebSocketHandler) {},
        async close(ws: WebSocketHandler, code, message) {
            ws.data.subscriptions.forEach(async (value, key) => {
                switch (value.type) {
                    case SubscriptionType.PUBSUB:
                        await subClient.unsubscribe(key);
                        break;
                    case SubscriptionType.INTERVAL:
                        clearInterval(value.interval);
                        break;
                    case SubscriptionType.ELECTION:
                        await quitBeingLeader(key);
                        break;
                }
            });
        },
        drain(ws: WebSocketHandler) {},
    },
});
