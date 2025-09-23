import { subClient, pubClient } from "./kassspay-connections/pubsub";
import * as Sentry from "@sentry/node";

Sentry.init({
    dsn: "https://e5d56f0c20b48b3af95c17385e8cebbc@o4509874905088000.ingest.us.sentry.io/4510071572463616",
    // Setting this option to true will send default PII data to Sentry.
    // For example, automatic IP address collection on events
    sendDefaultPii: true,
    environment:
        process.env.PUBLIC_ENV === "DEV" ? "development" : "production",
});

export enum SubscriptionType {
    INTERVAL,
    PUBSUB,
    ELECTION,
}

export type WebSocketHandler = Bun.ServerWebSocket<{
    window_open: boolean;
    subscriptions: Map<
        string,
        {
            type: SubscriptionType;
            interval?: NodeJS.Timeout;
            pubsubListener?: any;
        }
    >;
}>;

export const pubsubWebsocketSubscribe = async (
    ws: WebSocketHandler,
    key: string,
    func: (message: string) => void
) => {
    ws.data.subscriptions.set(key, {
        type: SubscriptionType.PUBSUB,
        pubsubListener: func,
    });
    await subClient.subscribe(key, func);
};
