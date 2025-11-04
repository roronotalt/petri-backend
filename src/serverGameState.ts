import { pubClient, subClient } from "./petri-connections";
import type {
   join_game_response_schema,
   server_responses_schema,
   tick_update_response_schema,
} from "./shared_types";
import {
   calculate_aabb,
   global_logger,
   GRID_CELL_SIZE,
   INITIAL_PLAYER_RADIUS,
   player_metadata_schema,
   private_player_data_schema,
   SERVER_CONSTANTS,
   TICK_FPS,
   WORLD_RADIUS,
} from "./stores";
import { z } from "zod";

type PositionalPlayerData = {
   x: number;
   y: number;
   r: number;
   minx: number;
   maxx: number;
   miny: number;
   maxy: number;
   angle: number;
   magnitude: number;
   _player_cache: string[];
   _cells: Set<bigint>;
};
import { Kparse, Kstringify } from "@kasssandra/kassspay";

type PlayerUUID = string;

const player_backup_data_schema = z.object({
   x: z.number(),
   y: z.number(),
   r: z.number(),
   angle: z.number(),
   magnitude: z.number(),
});

export class ServerGameState {
   private readonly grid: Map<bigint, Set<PlayerUUID>>;
   /**
    * Players in the game, indexed by their UUID
    */
   private readonly players = new Map<PlayerUUID, PositionalPlayerData>();
   private tick_blocked = false;

   constructor() {
      this.grid = new Map<bigint, Set<PlayerUUID>>();
   }

   async start() {
      /**
       * Load the players into memory from backup.
       * @TODO: Redis is not a persistent database
       */
      let cursor = "0";
      do {
         const { cursor: new_cursor, keys } = await pubClient.scan(cursor, {
            MATCH: "player:backup:*",
            COUNT: 1000,
         });
         cursor = new_cursor;
         if (keys.length !== 0) {
            const fetched_backups = await pubClient.mGet(keys);
            const backups = fetched_backups
               .map((p, i) => [keys[i]!, p])
               .filter(([, p]) => p != null) as [string, string][];
            for (const [player_uuid, backup] of backups) {
               const backup_data = player_backup_data_schema.safeParse(Kparse(backup));
               if (!backup_data.success) {
                  global_logger.warn(
                     "Failed to parse internal player message into player_backup_data_schema",
                     backup,
                  );
                  continue;
               }
               const circle_aabb = calculate_aabb(
                  backup_data.data.x,
                  backup_data.data.y,
                  backup_data.data.angle,
                  backup_data.data.magnitude,
                  backup_data.data.r,
                  backup_data.data.r,
               );

               const cells = this._cellsIntersectingAabb({
                  minX: circle_aabb.minX,
                  minY: circle_aabb.minY,
                  maxX: circle_aabb.maxX,
                  maxY: circle_aabb.maxY,
               });

               this.players.set(player_uuid, {
                  ...backup_data.data,
                  minx: circle_aabb.minX,
                  maxx: circle_aabb.maxX,
                  miny: circle_aabb.minY,
                  maxy: circle_aabb.maxY,
                  _player_cache: [],
                  _cells: cells,
               });
            }
         }
      } while (cursor !== "0");

      subClient.subscribe("player:join_game", async (message) => {
         const player = player_metadata_schema.safeParse(Kparse(message));
         if (!player.success) {
            global_logger.fatal(
               "Failed to parse internal player message into player_metadata_schema",
               player.error,
            );
            return;
         }

         const starting_location = {
            x: WORLD_RADIUS / 2 + Math.random() * 100,
            y: WORLD_RADIUS / 2 + Math.random() * 100,
         };

         const circle_aabb = calculate_aabb(
            starting_location.x,
            starting_location.y,
            0,
            0,
            INITIAL_PLAYER_RADIUS,
            INITIAL_PLAYER_RADIUS,
         );

         const cells = this._cellsIntersectingAabb({
            minX: circle_aabb.minX,
            minY: circle_aabb.minY,
            maxX: circle_aabb.maxX,
            maxY: circle_aabb.maxY,
         });

         cells.forEach((k) => {
            let cell = this.grid.get(k);
            if (!cell) this.grid.set(k, (cell = new Set<PlayerUUID>()));
            cell.add(player.data.uuid);
         });

         this.players.set(player.data.uuid, {
            x: starting_location.x,
            y: starting_location.y,
            r: INITIAL_PLAYER_RADIUS,
            minx: circle_aabb.minX,
            maxx: circle_aabb.maxX,
            miny: circle_aabb.minY,
            maxy: circle_aabb.maxY,
            angle: 0,
            magnitude: 0,
            _player_cache: [],
            _cells: cells,
         });

         await pubClient.publish(
            `player:${player.data.uuid}`,
            Kstringify({
               method: "join_game",
               data: {
                  x: starting_location.x,
                  y: starting_location.y,
                  r: INITIAL_PLAYER_RADIUS,
                  world_r: WORLD_RADIUS,
               },
            } satisfies z.infer<typeof join_game_response_schema>),
         );
      });

      // start the tick loop
      setInterval(() => this.tick(), 1000 / TICK_FPS);
   }

   // 32 bit hash of the cell coordinates
   private _cellHash(cx: number, cy: number): bigint {
      const x = BigInt(cx) & 0xffffffffn;
      const y = BigInt(cy) & 0xffffffffn;
      return (x << 32n) | y;
   }

   private _cellsIntersectingAabb({
      minX,
      minY,
      maxX,
      maxY,
   }: {
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
   }): Set<bigint> {
      const cx1 = Math.floor(minX / GRID_CELL_SIZE);
      const cy1 = Math.floor(minY / GRID_CELL_SIZE);
      const cx2 = Math.floor(maxX / GRID_CELL_SIZE);
      const cy2 = Math.floor(maxY / GRID_CELL_SIZE);

      const cells = new Set<bigint>();
      for (let cy = cy1; cy <= cy2; cy++) {
         for (let cx = cx1; cx <= cx2; cx++) {
            cells.add(this._cellHash(cx, cy));
         }
      }
      return cells;
   }

   private async _updatePlayerPositions() {
      let cursor = "0";
      do {
         const { cursor: new_cursor, keys } = await pubClient.scan(cursor, {
            MATCH: "player:private:*",
            COUNT: 1000,
         });
         cursor = new_cursor;
         if (keys.length !== 0) {
            const jobs: Promise<unknown>[] = [];

            const fetched_players = await pubClient.mGet(keys);
            const players = fetched_players
               .map((p, i) => [keys[i]!, p])
               .filter(([, p]) => p != null) as [string, string][];
            for (const [private_key, player] of players) {
               const parsed_player = private_player_data_schema.safeParse(Kparse(player));
               if (!parsed_player.success) {
                  global_logger.warn(
                     "Failed to parse internal player message into private_player_data_schema",
                     player,
                     parsed_player.error,
                  );
                  continue;
               }
               const player_position = this.players.get(parsed_player.data.uuid);
               if (player_position == undefined) {
                  global_logger.warn("Player not found in players map", parsed_player.data);
                  jobs.push(pubClient.del(private_key));
                  continue;
               }

               player_position.x +=
                  parsed_player.data.vector.magnitude * Math.cos(parsed_player.data.vector.angle);
               player_position.y +=
                  parsed_player.data.vector.magnitude * Math.sin(parsed_player.data.vector.angle);
               player_position.angle = parsed_player.data.vector.angle;
               player_position.magnitude = parsed_player.data.vector.magnitude;

               // calculate the aabb for the player's circle, to use for vision calculations
               const circle_aabb = calculate_aabb(
                  player_position.x,
                  player_position.y,
                  parsed_player.data.vector.angle,
                  parsed_player.data.vector.magnitude,
                  player_position.r,
                  player_position.r,
               );
               player_position.minx = circle_aabb.minX;
               player_position.maxx = circle_aabb.maxX;
               player_position.miny = circle_aabb.minY;
               player_position.maxy = circle_aabb.maxY;

               // save a backup of the player data
               jobs.push(
                  pubClient.set(
                     `player:backup:${parsed_player.data.uuid}`,
                     Kstringify({
                        x: player_position.x,
                        y: player_position.y,
                        r: player_position.r,
                        angle: player_position.angle,
                        magnitude: player_position.magnitude,
                     } satisfies z.infer<typeof player_backup_data_schema>),
                  ),
               );
            }
            await Promise.all(jobs);
         }
      } while (cursor !== "0");
   }

   private _updatePlayerCells() {
      for (const [player_uuid, player] of this.players.entries()) {
         const circle_cells = this._cellsIntersectingAabb({
            minX: player.minx,
            minY: player.miny,
            maxX: player.maxx,
            maxY: player.maxy,
         });
         let unchanged = true;
         if (player._cells.size !== circle_cells.size) unchanged = false;

         player._cells.difference(circle_cells).forEach((c) => {
            if (unchanged) {
               unchanged = false;
            }

            this.grid.get(c)?.delete(player_uuid);
            if (this.grid.get(c)?.size === 0) {
               this.grid.delete(c);
            }
         });
         if (unchanged) return;
         circle_cells.difference(player._cells).forEach((c) => {
            if (!this.grid.has(c)) {
               this.grid.set(c, new Set<PlayerUUID>());
            }
            this.grid.get(c)!.add(player_uuid);
         });
         player._cells = circle_cells;
      }
   }

   private async _broadcastTickUpdate() {
      const jobs: Promise<unknown>[] = [];
      for (const [player_uuid, player] of this.players.entries()) {
         const vision_aabb = calculate_aabb(
            player.x,
            player.y,
            player.angle,
            player.magnitude,
            player.r + SERVER_CONSTANTS.width / 2,
            player.r + SERVER_CONSTANTS.height / 2,
         );

         const vision_cells = this._cellsIntersectingAabb({
            minX: vision_aabb.minX,
            minY: vision_aabb.minY,
            maxX: vision_aabb.maxX,
            maxY: vision_aabb.maxY,
         });

         const vision_players = new Set<PlayerUUID>();
         // send these players to the client for caching
         vision_cells.forEach((c) => {
            this.grid.get(c)?.forEach((p) => p !== player_uuid && vision_players.add(p));
         });

         const relative_positions = Array.from(
            vision_players
               .entries()
               .map(([key, value]) => ({
                  ...this.players.get(value)!,
                  uuid: key,
               }))
               .filter(
                  (p) =>
                     p.x >= vision_aabb.minX &&
                     p.x <= vision_aabb.maxX &&
                     p.y >= vision_aabb.minY &&
                     p.y <= vision_aabb.maxY,
               )
               .map((p) => ({
                  uuid: p.uuid,
                  x: p.x - player.x,
                  y: p.y - player.y,
                  r: p.r,
                  angle: p.angle,
                  magnitude: p.magnitude,
               })),
         );

         jobs.push(
            pubClient.publish(
               `player:${player_uuid}`,
               Kstringify({
                  method: "tick_update",
                  data: { relative_positions },
               } satisfies z.infer<typeof tick_update_response_schema>),
            ),
         );
      }
      await Promise.all(jobs);
   }

   private async tick() {
      if (this.tick_blocked) {
         global_logger.debug("Tick blocked, skipping");
         return;
      }
      this.tick_blocked = true;
      this._updatePlayerPositions();
      this._updatePlayerCells();
      await this._broadcastTickUpdate();
      this.tick_blocked = false;
   }
}
