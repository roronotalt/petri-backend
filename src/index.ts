import dotenv from "dotenv";
import { z } from "zod";
import { Kparse, Kstringify, KWebsocketMethods } from "@kasssandra/kassspay";
import {
   private_player_data_schema,
   pubsub_websocket_subscribe,
   SubscriptionType,
   type WebSocketHandler,
} from "./stores";
import { awaitRedisConnect, pubClient, subClient } from "./petri-connections/pubsub";
import {
   client_join_game_schema,
   server_methods_schema,
   server_responses_schema,
} from "./shared_types";
import { player_metadata_schema } from "./stores";
import { ServerGameState } from "./serverGameState";
import Bun from "bun";
import { client_update_vector_schema } from "./shared_types";

dotenv.config();
await awaitRedisConnect();

// @TODO: graceful shutdown
async function deleteAllGameData() {
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
}
deleteAllGameData();

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
   pubClient.publish(
      "player:join_game",
      Kstringify({
         uuid: player_uuid,
         username: params.name,
      } satisfies z.infer<typeof player_metadata_schema>),
   );

   //@TODO: set the position & heartbeat *as* the player is joining based on their mouse position on the client
   await pubClient.set(
      `player:private:${params.secret_key}`,
      Kstringify({
         uuid: player_uuid,
         vector: {
            angle: 0,
            magnitude: 0,
            client_heartbeat: Date.now(),
            server_heartbeat: Date.now(),
         },
      } satisfies z.infer<typeof private_player_data_schema>),
   );

   pubsub_websocket_subscribe(ws, `player:${player_uuid}`, (message) => {
      ws.send(
         Kstringify({
            id: sub_id,
            type: "success",
            data: Kparse(message),
         } satisfies z.infer<typeof server_responses_schema>),
      );
   });
};

const update_vector = async (
   ws: WebSocketHandler,
   sub_id: string,
   params: z.infer<typeof client_update_vector_schema>,
) => {
   // @TODO: some sort of latency/network connection checks
   const player_vector_string = await pubClient.get(`player:private:${params.secret_key}`);
   if (player_vector_string == null) {
      ws.send(
         Kstringify({
            id: sub_id,
            error: { code: 404, message: "Player not found" },
         }),
      );
   }

   await pubClient.set(
      `player:private:${params.secret_key}`,
      Kstringify({
         uuid: Kparse(player_vector_string!).uuid,
         vector: {
            angle: params.angle,
            magnitude: params.magnitude,
            client_heartbeat: params.client_heartbeat,
            server_heartbeat: Date.now(),
         },
      } satisfies z.infer<typeof private_player_data_schema>),
   );
};

Bun.serve<WebSocketHandler["data"]>({
   fetch(req, server) {
      if (
         server.upgrade(req, {
            data: {
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
            case "update_vector":
               await update_vector(ws, parsed.id, parsed.params);
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
