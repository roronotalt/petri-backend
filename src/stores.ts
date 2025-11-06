import { KLogger, type KLoggerLevel } from "@kasssandra/klogger";
import { subClient, pubClient } from "./petri-connections/pubsub";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import Bun from "bun";
import { tick_update_response_schema } from "./shared_types";

/* eslint-disable @typescript-eslint/naming-convention */
export const SERVER_CONSTANTS = {
   width: 1920,
   height: 1080,
};
export const TICK_FPS = 60;
export const WORLD_RADIUS = 1000;
export const INITIAL_PLAYER_RADIUS = 10;
export const GRID_CELL_SIZE = 100;
export const ZOOM_FACTOR_BASE = 0.25;
/* eslint-enable @typescript-eslint/naming-convention */

export enum SubscriptionType {
   INTERVAL,
   PUBSUB,
}

export type WebSocketHandler = Bun.ServerWebSocket<{
   window_open: boolean;
   game_data: {
      uuid: string;
   } | null;
   subscriptions: Map<
      string,
      {
         type: SubscriptionType;
         interval?: ReturnType<typeof setTimeout>;
         pubsubListener?: (message: string) => void;
      }
   >;
}>;

export const pubsub_websocket_subscribe = async (
   ws: WebSocketHandler,
   key: string,
   func: (message: string) => void,
) => {
   ws.data.subscriptions.set(key, {
      type: SubscriptionType.PUBSUB,
      pubsubListener: func,
   });
   await subClient.subscribe(key, func);
};

export const pubsub_websocket_unsubscribe = async (ws: WebSocketHandler, key: string) => {
   ws.data.subscriptions.delete(key);
   await subClient.unsubscribe(key);
};

export const player_metadata_schema = z.object({
   uuid: z.string(),
   username: z.string(),
});

export const player_update_position_schema = z.object({
   uuid: z.string(),
   x: z.number(),
   y: z.number(),
});

export const global_logger = new KLogger({
   service_name: process.env.SERVICE_NAME as string,
   level: process.env.PUBLIC_LOG_LEVEL as KLoggerLevel,
});

Sentry.init({
   dsn: "https://e5d56f0c20b48b3af95c17385e8cebbc@o4509874905088000.ingest.us.sentry.io/4510071572463616",
   // Setting this option to true will send default PII data to Sentry.
   // For example, automatic IP address collection on events
   sendDefaultPii: true,
   environment: process.env.PUBLIC_ENV === "DEV" ? "development" : "production",
});

export const calculate_aabb = (
   x: number,
   y: number,
   vx: number,
   vy: number,
   wr: number,
   hr: number,
) => {
   const nx = x + vx * (1 / TICK_FPS),
      ny = y + vy * (1 / TICK_FPS);
   return {
      minX: Math.min(x, nx) - wr,
      minY: Math.min(y, ny) - hr,
      maxX: Math.max(x, nx) + wr,
      maxY: Math.max(y, ny) + hr,
   };
};
