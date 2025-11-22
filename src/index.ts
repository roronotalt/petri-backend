import dotenv from "dotenv";
import { z } from "zod";
import { Kparse, Kstringify } from "@kasssandra/kassspay";
import {
  internal_server_responses_schema,
  player_update_position_schema,
  pubsub_websocket_subscribe,
  pubsub_websocket_unsubscribe,
  SubscriptionType,
  WORLD_RADIUS,
  type WebSocketHandler,
} from "./stores";
import { awaitRedisConnect, pubClient, subClient } from "./petri-connections/pubsub";
import {
  CLIENT_HEIGHT_PIXELS,
  client_join_game_schema,
  client_update_position_schema,
  CLIENT_WIDTH_PIXELS,
  server_methods_schema,
  server_responses_schema,
} from "./shared_types";
import { player_metadata_schema } from "./stores";
import { ServerGameState } from "./serverGameState";
import Bun from "bun";

dotenv.config();
await awaitRedisConnect();

// @TODO: graceful shutdown
const delete_all_game_data = async () => {
  let cursor: string = "0";
  do {
    const { cursor: new_cursor, keys } = await pubClient.scan(cursor, {
      MATCH: "cell:*",
      COUNT: 1000,
    });
    cursor = new_cursor;
    if (keys.length) {
      await pubClient.del(keys);
    }
  } while (cursor !== "0");
  cursor = "0";
  do {
    const { cursor: new_cursor, keys } = await pubClient.scan(cursor, {
      MATCH: "player:*",
      COUNT: 1000,
    });
    cursor = new_cursor;
    if (keys.length) {
      await pubClient.del(keys);
    }
  } while (cursor !== "0");
};
await delete_all_game_data();

if (process.env.TICK_SERVER == "YES") {
  const server_game_state = new ServerGameState();
  await server_game_state.start();
}

const join_game = async (
  ws: WebSocketHandler,
  sub_id: string,
  params: z.infer<typeof client_join_game_schema>,
) => {
  const player_uuid = crypto.randomUUID();
  // error out after 10 seconds of no response to joining the game
  const join_game_timer = setTimeout(async () => {
    ws.send(
      Kstringify({
        id: sub_id,
        type: "error",
        error: { code: 408, message: "Joining the game timed out" },
      } satisfies z.infer<typeof server_responses_schema>),
    );
    await pubsub_websocket_unsubscribe(ws, `player:${player_uuid}`);
  }, 10000);

  await pubsub_websocket_subscribe(ws, `player:${player_uuid}`, async (message) => {
    const parsed_message = Kparse(message) as z.infer<typeof internal_server_responses_schema>;
    let processed_message: Extract<
      z.infer<typeof server_responses_schema>,
      { type: "success" }
    >["data"];

    switch (parsed_message.method) {
      case "join_game":
        clearTimeout(join_game_timer);

        processed_message = {
          ...parsed_message,
          data: {
            ...parsed_message.data,
            self_blobs: parsed_message.data.self_blobs.map((blob) => ({
              ...blob,
              x: blob.x - parsed_message.data.com_x + CLIENT_WIDTH_PIXELS / 2,
              y: parsed_message.data.com_y - blob.y + CLIENT_HEIGHT_PIXELS / 2,
            })),
            world_objects: parsed_message.data.world_objects.map(([key, object]) => [
              key,
              {
                ...object,
                x: object.x - parsed_message.data.com_x + CLIENT_WIDTH_PIXELS / 2,
                y: parsed_message.data.com_y - object.y + CLIENT_HEIGHT_PIXELS / 2,
                r: object.r,
              },
            ]),
            other_blobs: parsed_message.data.other_blobs.map(([key, blob]) => [
              key,
              {
                ...blob,
                x: blob.x - parsed_message.data.com_x + CLIENT_WIDTH_PIXELS / 2,
                y: parsed_message.data.com_y - blob.y + CLIENT_HEIGHT_PIXELS / 2,
                r: blob.r,
              },
            ]),
          },
        };
        ws.data.game_data = {
          uuid: player_uuid,
        };

        //@TODO: set the position & heartbeat *as* the player is joining based on their mouse position on the client
        // @TODO: better authentication system
        await pubClient
          .multi()
          .set(`player:uuid:${player_uuid}`, params.secret_key)
          .set(`player:secret_key:${params.secret_key}`, player_uuid)
          .exec();
        break;
      case "tick_update": {
        // convert to relative coordinates
        processed_message = {
          ...parsed_message,
          data: {
            ...parsed_message.data,
            self_blobs: parsed_message.data.self_blobs.map((blob) => ({
              ...blob,
              x: blob.x - parsed_message.data.com_x + CLIENT_WIDTH_PIXELS / 2,
              y: parsed_message.data.com_y - blob.y + CLIENT_HEIGHT_PIXELS / 2,
            })),
            world_objects: parsed_message.data.world_objects.map(([key, object]) => [
              key,
              {
                ...object,
                x: object.x - parsed_message.data.com_x + CLIENT_WIDTH_PIXELS / 2,
                y: parsed_message.data.com_y - object.y + CLIENT_HEIGHT_PIXELS / 2,
                r: object.r,
              },
            ]),
            other_blobs: parsed_message.data.other_blobs.map(([key, blob]) => [
              key,
              {
                ...blob,
                x: blob.x - parsed_message.data.com_x + CLIENT_WIDTH_PIXELS / 2,
                y: parsed_message.data.com_y - blob.y + CLIENT_HEIGHT_PIXELS / 2,
                r: blob.r,
              },
            ]),
          },
        };
        break;
      }
    }

    ws.send(
      Kstringify({
        id: sub_id,
        type: "success",
        data: processed_message,
      } satisfies z.infer<typeof server_responses_schema>),
    );
  });

  await pubClient.publish(
    "player:join_game",
    Kstringify({
      uuid: player_uuid,
      username: params.name,
    } satisfies z.infer<typeof player_metadata_schema>),
  );
};

const update_position = async (
  ws: WebSocketHandler,
  params: z.infer<typeof client_update_position_schema>,
) => {
  // @TODO: some sort of latency/network connection checks
  if (ws.data.game_data == null) {
    return;
  }

  await pubClient.publish(
    "player:update_position",
    Kstringify({
      uuid: ws.data.game_data.uuid,
      x: params.x,
      y: params.y,
    } satisfies z.infer<typeof player_update_position_schema>),
  );
};

Bun.serve<WebSocketHandler["data"]>({
  fetch(req, server) {
    if (
      server.upgrade(req, {
        data: {
          subscriptions: new Map(),
          window_open: true,
          game_data: null,
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
  port: 3001,
  websocket: {
    async message(ws: WebSocketHandler, message) {
      let parsed: z.infer<typeof server_methods_schema>;
      try {
        const formatted = Kparse(message.toString());
        const result = server_methods_schema.safeParse(formatted);
        if (!result.success) {
          ws.send(
            Kstringify({
              id: formatted.id,
              type: "error",
              error: {
                code: 400,
                message: result.error.issues[0]?.message ?? "Unknown error",
              },
            } satisfies z.infer<typeof server_responses_schema>),
          );
          return;
        }
        parsed = result.data;
      } catch {
        ws.send(
          Kstringify({
            type: "error",
            id: null,
            error: {
              code: 400,
              message: "Kparse failed, make sure you are using Kstringify",
            },
          } satisfies z.infer<typeof server_responses_schema>),
        );
        return;
      }

      switch (parsed.method) {
        case "join_game":
          await join_game(ws, parsed.id, parsed.params);
          break;
        case "update_position":
          await update_position(ws, parsed.params);
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
        }
      });
    },
    drain(ws: WebSocketHandler) {},
  },
});
