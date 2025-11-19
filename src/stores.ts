import { KLogger, type KLoggerLevel } from "@kasssandra/klogger";
import { subClient, pubClient } from "./petri-connections/pubsub";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import Bun from "bun";
import { join_game_response_schema, tick_update_response_schema } from "./shared_types";

/* eslint-disable @typescript-eslint/naming-convention */
/** Game server ticks per second */
export const TPS = 60;
/** In pixels */
export const WORLD_RADIUS = 300;
/**
 * Multiplicative factor by which player view is "zoomed" in. server calculates this value to ajust
 * perspective and vision aabb for a player.
 */
export const ZOOM_FACTOR_BASE = 0.25;

/** In pixels */
export const INITIAL_PLAYER_RADIUS = 20;
/** In pixels */
export const GRID_CELL_SIZE = 100;

/** In pixels */
export const MINIMUM_FOOD_RADIUS = 1;
/** In pixels */
export const MAXIMUM_FOOD_RADIUS = 3;
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

export const internal_tick_update_response_schema = tick_update_response_schema.extend({
  data: tick_update_response_schema.shape.data.omit({ world_border: true }),
});

export const internal_join_game_response_schema = join_game_response_schema.extend({
  data: join_game_response_schema.shape.data.omit({ world_border: true }),
});

export const internal_server_responses_schema = z.discriminatedUnion("method", [
  internal_join_game_response_schema,
  internal_tick_update_response_schema,
]);

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

/**
 * @remarks
 *   Width/height radius are equivalent to half width/height
 * @param x Coordinate
 * @param y Coordinate
 * @param wr Width radius
 * @param hr Height radius
 * @returns Axis aligned bounding box
 */
export const calculate_aabb = (x: number, y: number, wr: number, hr: number) => {
  return {
    minX: x - wr,
    minY: y - hr,
    maxX: x + wr,
    maxY: y + hr,
  };
};

/**
 * @remarks
 *   Width/height radius are equivalent to half width/height
 * @param x Coordinate
 * @param y Coordinate
 * @param vx X velocity component
 * @param vy Y velocity component
 * @param wr Width radius
 * @param hr Height radius
 * @returns Sweeping axis aligned bounding box
 */
export const sweeping_aabb = (
  x: number,
  y: number,
  vx: number,
  vy: number,
  wr: number,
  hr: number,
) => {
  const nx = x + vx * (1 / TPS),
    ny = y + vy * (1 / TPS);
  return {
    minX: Math.min(x, nx) - wr,
    minY: Math.min(y, ny) - hr,
    maxX: Math.max(x, nx) + wr,
    maxY: Math.max(y, ny) + hr,
  };
};
