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
import { db } from "./kassspay-connections/database";
import { Address, WalletType } from "./kassspay-connections/database/schema";
import { inArray, type InferSelectModel } from "drizzle-orm";
import { exitHandler } from "./exitHandler";
import { getWalletKNAddresses } from "./kassspay-connections/database/utils/wallet/getWalletKNAddresses";
import { getWalletMode } from "./kassspay-connections/database/utils/wallet/getWalletMode";
import { solanaSubscription } from "./solana/subscription";
import {
    pubsubWebsocketSubscribe,
    SubscriptionType,
    type WebSocketHandler,
} from "./stores";
import { subClient } from "./kassspay-connections/pubsub";
import { quitBeingLeader } from "./elections";

dotenv.config();
exitHandler;

const walletUpdatesSchema = z.object({
    wallet_type: z.enum(WalletType.enumValues),
    wallet_id: z.number().int().nonnegative(),
});

const serverZodSchema = z.discriminatedUnion("method", [
    z.object({
        id: z.string().max(100),
        method: z.enum(KWebsocketMethods),
        params: walletUpdatesSchema,
    }),
]);

const walletUpdates = async (
    ws: WebSocketHandler,
    client_subscription_id: string,
    params: z.infer<typeof walletUpdatesSchema>
) => {
    const existing = ws.data.subscriptions.get(
        "client_id_" + client_subscription_id
    );
    if (existing) {
        ws.send(
            Kstringify({
                error: "Subscription ID already exists",
                code: 400,
            })
        );
        return;
    }

    const [wallet_production_mode, addresses] = await Promise.all([
        getWalletMode({
            wallet_type: params.wallet_type,
            wallet_id: params.wallet_id,
        }),
        getWalletKNAddresses({
            wallet_type: params.wallet_type,
            wallet_id: params.wallet_id,
        }),
    ]);

    if (wallet_production_mode === undefined) {
        ws.send(
            Kstringify({
                error: "Wallet not found",
                code: 404,
            })
        );
        return;
    }

    const supported_networks: readonly KSupportedNetworks[] =
        wallet_production_mode
            ? KSupportedMainNetworks
            : KSupportedDeveloperNetworks;

    const wallets = await db.query.Address.findMany({
        where: inArray(Address.id, addresses),
        columns: {
            id: true,
            address_kind: true,
            public_address: true,
            kn_managed: true,
        },
    });

    // TODO: test to see if this works
    await pubsubWebsocketSubscribe(
        ws,
        `generate_wallet_address_${params.wallet_type}_${params.wallet_id}`,
        (message: string) => {
            const parsedMessage: InferSelectModel<typeof Address> =
                Kparse(message);
            wallets.push(parsedMessage);
        }
    );

    for (const wallet of wallets) {
        const networks = KAddressKindToNetworks(wallet.address_kind).filter(
            (network) => supported_networks.includes(network)
        );

        for (const network of networks) {
            switch (network) {
                case "solana":
                    await solanaSubscription(
                        ws,
                        client_subscription_id,
                        wallet,
                        network
                    );
                    break;
                case "solana devnet":
                    await solanaSubscription(
                        ws,
                        client_subscription_id,
                        wallet,
                        network
                    );
                    break;
            }
        }
    }
};

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
                    await walletUpdates(ws, parsed.id, parsed.params);
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
