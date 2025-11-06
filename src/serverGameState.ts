import { pubClient, subClient } from "./petri-connections";
import {
   parse_blob_uuid,
   type join_game_response_schema,
   type tick_update_response_schema,
} from "./shared_types";
import {
   calculate_aabb,
   global_logger,
   GRID_CELL_SIZE,
   INITIAL_PLAYER_RADIUS,
   player_metadata_schema,
   player_update_position_schema,
   SERVER_CONSTANTS,
   TICK_FPS,
   WORLD_RADIUS,
   ZOOM_FACTOR_BASE,
} from "./stores";
import { z } from "zod";

type BlobPositionalData = {
   x: number;
   y: number;
   r: number;
   vx: number;
   vy: number;
   minx: number;
   maxx: number;
   miny: number;
   maxy: number;
   _cells: Set<bigint>;
};

type PositionalPlayerData = {
   blobs: BlobPositionalData[];
   client_x: number;
   client_y: number;
   vision_minx: number;
   vision_maxx: number;
   vision_miny: number;
   vision_maxy: number;
   zoom_factor: number;
   _player_cache: string[];
};

const stringify_blob_uuid = (uuid: string, blob_index: number): string => {
   return `${uuid}:${blob_index}`;
};

import { Kparse, Kstringify } from "@kasssandra/kassspay";
import type { Worker } from "bun";

type PlayerUUID = string;

const game_state_worker: Worker = new Worker(new URL("./gameStateWorker.ts", import.meta.url));

export class ServerGameState {
   /**
    * Grid of cells, indexed by their hash
    * Each cell contains a set of blob IDs (stringified)
    * @see BlobID
    */
   private readonly grid: Map<bigint, Set<string>>;
   /**
    * Players in the game, indexed by their UUID
    */
   private readonly players = new Map<PlayerUUID, PositionalPlayerData>();

   constructor() {
      this.grid = new Map<bigint, Set<string>>();
   }

   async start() {
      await this._joinGameListener();
      await this._playerUpdatePositionListener();
      await this._startTickLoop();
   }

   private async _joinGameListener() {
      await subClient.subscribe("player:join_game", async (message) => {
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

         const blob_aabb = calculate_aabb(
            starting_location.x,
            starting_location.y,
            0,
            0,
            INITIAL_PLAYER_RADIUS,
            INITIAL_PLAYER_RADIUS,
         );

         const blob_cells = this._cellsIntersectingAabb({
            minX: blob_aabb.minX,
            minY: blob_aabb.minY,
            maxX: blob_aabb.maxX,
            maxY: blob_aabb.maxY,
         });

         this.players.set(player.data.uuid, {
            blobs: [
               {
                  x: starting_location.x,
                  y: starting_location.y,
                  r: INITIAL_PLAYER_RADIUS,
                  minx: blob_aabb.minX,
                  maxx: blob_aabb.maxX,
                  miny: blob_aabb.minY,
                  maxy: blob_aabb.maxY,
                  vx: 0,
                  vy: 0,
                  _cells: blob_cells,
               },
            ],
            client_x: starting_location.x,
            client_y: starting_location.y,
            vision_minx: blob_aabb.minX,
            vision_maxx: blob_aabb.maxX,
            vision_miny: blob_aabb.minY,
            vision_maxy: blob_aabb.maxY,
            zoom_factor: ZOOM_FACTOR_BASE,
            _player_cache: [],
         });

         blob_cells.forEach((k) => {
            let cell = this.grid.get(k);
            if (!cell) this.grid.set(k, (cell = new Set<string>()));
            cell.add(stringify_blob_uuid(player.data.uuid, 0));
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
   }

   private async _playerUpdatePositionListener() {
      await subClient.subscribe("player:update_position", async (message) => {
         const update_position = player_update_position_schema.safeParse(Kparse(message));
         if (!update_position.success) {
            global_logger.warn(
               "Failed to parse internal player message into player_update_position_schema",
               message,
               update_position.error,
            );
            return;
         }
         const player = this.players.get(update_position.data.uuid);
         if (player == undefined) return;

         try {
            player.client_x = update_position.data.x;
            player.client_y = update_position.data.y;
         } catch {
            // player may have been deleted since the update position was sent; ignore
         }
      });
   }

   // 32 bit hash of the cell coordinates
   private static _cellHash(cx: number, cy: number): bigint {
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
            cells.add(ServerGameState._cellHash(cx, cy));
         }
      }
      return cells;
   }

   private async _updatePlayerPositions() {
      for (const player of this.players.values()) {
         let player_r = 0,
            sx = 0,
            sy = 0,
            sm = 0;
         player.blobs.forEach((blob) => {
            const dx = blob.x - player.client_x;
            const dy = blob.y - player.client_y;
            const magnitude = Math.max(blob.r, Math.hypot(dx, dy)) / blob.r;
            // semi-implicit euler
            blob.vx = dx * (1 / TICK_FPS) * magnitude;
            blob.vy = dy * (1 / TICK_FPS) * magnitude;
            blob.x += blob.vx;
            blob.y += blob.vy;

            const blob_aabb = calculate_aabb(blob.x, blob.y, blob.vx, blob.vy, blob.r, blob.r);
            blob.minx = blob_aabb.minX;
            blob.maxx = blob_aabb.maxX;
            blob.miny = blob_aabb.minY;
            blob.maxy = blob_aabb.maxY;

            const m = blob.r * blob.r; // area-proportional mass (π cancels)
            sx += blob.x * m;
            sy += blob.y * m;
            sm += m;

            player_r += blob.r;
         });

         player.zoom_factor = Math.log(player.blobs.length + player_r) + ZOOM_FACTOR_BASE;

         const player_x = sx / sm;
         const player_y = sy / sm;
         const vision_aabb = calculate_aabb(
            player_x,
            player_y,
            0,
            0,
            (SERVER_CONSTANTS.width / 2) * player.zoom_factor,
            (SERVER_CONSTANTS.height / 2) * player.zoom_factor,
         );

         player.vision_minx = vision_aabb.minX;
         player.vision_maxx = vision_aabb.maxX;
         player.vision_miny = vision_aabb.minY;
         player.vision_maxy = vision_aabb.maxY;
      }
   }

   private _updatePlayerCells() {
      for (const [player_uuid, player] of this.players.entries()) {
         for (const [blob_index, blob] of player.blobs.entries()) {
            const blob_cells = this._cellsIntersectingAabb({
               minX: blob.minx,
               minY: blob.miny,
               maxX: blob.maxx,
               maxY: blob.maxy,
            });
            let unchanged = true;
            if (blob._cells.size !== blob_cells.size) unchanged = false;
            const blob_uuid = stringify_blob_uuid(player_uuid, blob_index);
            blob._cells.difference(blob_cells).forEach((c) => {
               if (unchanged) {
                  unchanged = false;
               }

               this.grid.get(c)?.delete(blob_uuid);
               if (this.grid.get(c)?.size === 0) {
                  this.grid.delete(c);
               }
            });

            if (unchanged) continue;
            blob_cells.difference(blob._cells).forEach((c) => {
               if (!this.grid.has(c)) {
                  this.grid.set(c, new Set<string>());
               }
               this.grid.get(c)!.add(blob_uuid);
            });
            blob._cells = blob_cells;
         }
      }
   }

   private async _broadcastTickUpdate() {
      const jobs: Promise<unknown>[] = [];
      for (const [player_uuid, player] of this.players.entries()) {
         const other_blobs: Record<
            string,
            z.infer<typeof tick_update_response_schema>["data"]["other_blobs"][number]
         > = {};

         // @TODO: send these players to the client for caching, using difference
         const players_in_vision_cells = new Set<PlayerUUID>();
         const vision_cells = this._cellsIntersectingAabb({
            minX: player.vision_minx,
            minY: player.vision_miny,
            maxX: player.vision_maxx,
            maxY: player.vision_maxy,
         });
         vision_cells.forEach((c) => {
            this.grid.get(c)?.forEach((blob_uuid) => {
               const { uuid, blob_index } = parse_blob_uuid(blob_uuid);
               if (uuid === player_uuid) return;

               players_in_vision_cells.add(uuid);

               const blob = this.players.get(uuid)!.blobs[blob_index]!;
               if (
                  blob.x >= player.vision_minx &&
                  blob.x <= player.vision_maxx &&
                  blob.y >= player.vision_miny &&
                  blob.y <= player.vision_maxy
               ) {
                  other_blobs[blob_uuid] = {
                     x: blob.x,
                     y: blob.y,
                     r: blob.r,
                     vx: blob.vx,
                     vy: blob.vy,
                  };
               }
            });
         });

         jobs.push(
            pubClient.publish(
               `player:${player_uuid}`,
               Kstringify({
                  method: "tick_update",
                  data: {
                     self_blobs: player.blobs.map((b) => ({ x: b.x, y: b.y, r: b.r })),
                     zoom_factor: player.zoom_factor,
                     other_blobs,
                  },
               } satisfies z.infer<typeof tick_update_response_schema>),
            ),
         );
      }
      await Promise.all(jobs);
   }

   private async tick() {
      // global_logger.info("Tick started", performance.now());
      await this._updatePlayerPositions();
      // global_logger.info("player positions updated", performance.now());
      this._updatePlayerCells();
      // global_logger.info("player cells updated", performance.now());
      await this._broadcastTickUpdate();
      // global_logger.info("tick update broadcasted", performance.now());
   }
   private async _startTickLoop() {
      const tick_start_time = performance.now();
      await this.tick();
      const elapsed = performance.now() - tick_start_time;
      const target = 1000 / TICK_FPS;
      const delay = Math.max(0, target - elapsed);
      setTimeout(() => this._startTickLoop(), delay);
   }
}
