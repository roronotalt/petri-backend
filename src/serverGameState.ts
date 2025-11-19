import { z } from "zod";
import { pubClient, subClient } from "./petri-connections";
import {
  type join_game_response_schema,
  type tick_update_response_schema,
  CLIENT_HEIGHT_PIXELS,
  CLIENT_WIDTH_PIXELS,
} from "./shared_types";
import {
  calculate_aabb,
  global_logger,
  GRID_CELL_SIZE,
  INITIAL_PLAYER_RADIUS,
  internal_join_game_response_schema,
  internal_tick_update_response_schema,
  MAXIMUM_FOOD_RADIUS,
  MINIMUM_FOOD_RADIUS,
  player_metadata_schema,
  player_update_position_schema,
  sweeping_aabb,
  TPS,
  WORLD_RADIUS,
  ZOOM_FACTOR_BASE,
} from "./stores";

type Blob = {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  _cells: Set<bigint>;
};

const stuff = 1;

/** Server player object */
type Player = {
  blobs: Blob[];
  client_x: number;
  client_y: number;
  com_x: number;
  com_y: number;
  vision_minX: number;
  vision_maxX: number;
  vision_minY: number;
  vision_maxY: number;
  zoom_factor: number;
  _player_cache: string[];
};

type Food = {
  type: "food";
  x: number;
  y: number;
  r: number;
};

type Virus = {
  type: "virus";
  x: number;
  y: number;
  r: number;
};

type WorldObject = (Food | Virus) & {
  minx: number;
  maxX: number;
  minY: number;
  maxY: number;
};

enum EntityType {
  PLAYER = "p",
  WORLD_OBJECT = "w",
}

type CellUUID =
  | {
      type: EntityType.PLAYER;
      uuid: string;
      blob_index: number;
    }
  | {
      type: EntityType.WORLD_OBJECT;
      uuid: string;
    };

const stringify_cell_uuid = (cell_uuid: CellUUID): string => {
  switch (cell_uuid.type) {
    case EntityType.PLAYER:
      return `${cell_uuid.type}:${cell_uuid.uuid}:${cell_uuid.blob_index}`;
    case EntityType.WORLD_OBJECT:
      return `${cell_uuid.type}:${cell_uuid.uuid}`;
  }
};

const parse_cell_uuid = (cell_uuid: string): CellUUID => {
  const [type, uuid, blob_index] = cell_uuid.split(":") as [string, string, string];
  if (type === EntityType.PLAYER) {
    return { type: EntityType.PLAYER, uuid, blob_index: parseInt(blob_index) };
  }
  return { type: EntityType.WORLD_OBJECT, uuid };
};

import { Kparse, Kstringify } from "@kasssandra/kassspay";
import { jsdoc } from "eslint-plugin-jsdoc";

type PlayerUUID = string;
type WorldObjectUUID = string;

export class ServerGameState {
  /**
   * Grid of cells, indexed by their hash each cell contains a set of formatted uuids for either a
   * blob (player_uuid:blob_index) or an entity (uuid) we use uuids for players and entities to
   * avoid collisions between them, even though it's one in a quintillion chance
   *
   * @license MIT
   * @see CellUUID
   */
  private readonly grid: Map<bigint, Set<string>>;
  /** Players in the game, indexed by their UUID */
  private readonly players = new Map<PlayerUUID, Player>();
  private readonly world_objects = new Map<WorldObjectUUID, WorldObject>();
  /**
   * Players that are joining the game (yet to be inserted into the players map), indexed by their
   * UUID
   */
  private readonly joining_players = new Set<PlayerUUID>();
  /** Amount of food in the game, in cents */
  private food_amount = 0;

  constructor() {
    this.grid = new Map<bigint, Set<string>>();
  }

  async start() {
    await this._joinGameListener();
    await this._playerUpdatePositionListener();
    await this._startTickLoop(performance.now());
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

      this.joining_players.add(player.data.uuid);

      const starting_location = {
        x: WORLD_RADIUS * Math.random() - WORLD_RADIUS / 2,
        y: WORLD_RADIUS * Math.random() - WORLD_RADIUS / 2,
      };

      const blob_aabb = calculate_aabb(
        starting_location.x,
        starting_location.y,
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
            minX: blob_aabb.minX,
            maxX: blob_aabb.maxX,
            minY: blob_aabb.minY,
            maxY: blob_aabb.maxY,
            vx: 0,
            vy: 0,
            _cells: blob_cells,
          },
        ],
        client_x: starting_location.x,
        client_y: starting_location.y,
        com_x: starting_location.x,
        com_y: starting_location.y,
        vision_minX: blob_aabb.minX,
        vision_maxX: blob_aabb.maxX,
        vision_minY: blob_aabb.minY,
        vision_maxY: blob_aabb.maxY,
        zoom_factor: ZOOM_FACTOR_BASE,
        _player_cache: [],
      });

      blob_cells.forEach((k) => {
        let cell = this.grid.get(k);
        if (!cell) this.grid.set(k, (cell = new Set<string>()));
        cell.add(
          stringify_cell_uuid({
            type: EntityType.PLAYER,
            uuid: player.data.uuid,
            blob_index: 0,
          }),
        );
      });

      await pubClient.publish(
        `player:${player.data.uuid}`,
        Kstringify({
          method: "join_game",
          data: {
            x: starting_location.x,
            y: starting_location.y,
            r: INITIAL_PLAYER_RADIUS,
            zoom_factor: ZOOM_FACTOR_BASE,
          },
        } satisfies z.infer<typeof internal_join_game_response_schema>),
      );

      this.joining_players.delete(player.data.uuid);
      // @TODO: handle food amount dynamic
      this.food_amount += 100;
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

  private async _updatePlayerPositions(dt: number) {
    for (const player of this.players.values()) {
      let linear_radius = 0,
        total_mass = 0,
        total_x = 0,
        total_y = 0,
        min_x = Infinity,
        max_x = -Infinity,
        min_y = Infinity,
        max_y = -Infinity;
      player.blobs.forEach((blob) => {
        const blob_world_x = player.com_x + player.client_x - CLIENT_WIDTH_PIXELS / 2;
        const blob_world_y = player.com_y - player.client_y + CLIENT_HEIGHT_PIXELS / 2;
        let dx = blob_world_x - blob.x;
        let dy = blob_world_y - blob.y;

        const mass = blob.r * blob.r;
        const magnitude_squared = dx * dx + dy * dy;

        if (magnitude_squared != 0) {
          if (magnitude_squared > mass) {
            const n = blob.r / Math.sqrt(magnitude_squared);
            dx *= n;
            dy *= n;
          }
        }

        blob.x = Math.max(
          Math.min(blob.x + dx * dt * 100, WORLD_RADIUS - blob.r),
          -WORLD_RADIUS + blob.r,
        );
        blob.y = Math.max(
          Math.min(blob.y + dy * dt * 100, WORLD_RADIUS - blob.r),
          -WORLD_RADIUS + blob.r,
        );

        const blob_aabb = sweeping_aabb(blob.x, blob.y, blob.vx, blob.vy, blob.r, blob.r);
        blob.minX = blob_aabb.minX;
        blob.maxX = blob_aabb.maxX;
        blob.minY = blob_aabb.minY;
        blob.maxY = blob_aabb.maxY;

        min_x = Math.min(min_x, blob_aabb.minX);
        max_x = Math.max(max_x, blob_aabb.maxX);
        min_y = Math.min(min_y, blob_aabb.minY);
        max_y = Math.max(max_y, blob_aabb.maxY);

        total_x += blob.x * mass;
        total_y += blob.y * mass;
        linear_radius += blob.r;
        total_mass += mass;
      });

      player.zoom_factor = Math.log(linear_radius - INITIAL_PLAYER_RADIUS) + ZOOM_FACTOR_BASE;

      player.com_x = total_x / total_mass;
      player.com_y = total_y / total_mass;

      player.vision_minX = min_x;
      player.vision_maxX = max_x;
      player.vision_minY = min_y;
      player.vision_maxY = max_y;
    }
  }

  /**
   * @param radius - The radius of the entity to spawn, should be less than cell size
   * @returns A random collision free location within the world
   * @see GRID_CELL_SIZE
   */
  private _randomCollisionFreeLocation(radius: number): { x: number; y: number } {
    location: while (true) {
      const x = WORLD_RADIUS * Math.random() - WORLD_RADIUS / 2;
      const y = WORLD_RADIUS * Math.random() - WORLD_RADIUS / 2;
      const aabb = calculate_aabb(x, y, radius, radius);
      const cells = this._cellsIntersectingAabb({
        minX: aabb.minX,
        minY: aabb.minY,
        maxX: aabb.maxX,
        maxY: aabb.maxY,
      });
      if (cells.size === 0) return { x, y };

      for (const cell of cells) {
        for (const entity_uuid of this.grid.get(cell)!) {
          const entity = parse_cell_uuid(entity_uuid);
          switch (entity.type) {
            case EntityType.PLAYER: {
              continue;
            }
            case EntityType.WORLD_OBJECT: {
              continue;
            }
          }
        }
      }
    }
  }

  private _spawnFood() {
    let total_food_spawning_radius = this.food_amount - Math.log(this.food_amount + 1);
    this.food_amount -= total_food_spawning_radius;

    while (total_food_spawning_radius > MINIMUM_FOOD_RADIUS) {
      const food_radius =
        MINIMUM_FOOD_RADIUS + Math.random() * (MAXIMUM_FOOD_RADIUS - MINIMUM_FOOD_RADIUS);
      total_food_spawning_radius -= food_radius;
      const food_mass = food_radius * food_radius;

      while (true) {
        const food_x = WORLD_RADIUS * Math.random() - WORLD_RADIUS / 2;
        const food_y = WORLD_RADIUS * Math.random() - WORLD_RADIUS / 2;
        const food_aabb = calculate_aabb(food_x, food_y, food_radius, food_radius);
        const food_cells = this._cellsIntersectingAabb({
          minX: food_aabb.minX,
          maxX: food_aabb.maxX,
          minY: food_aabb.minY,
          maxY: food_aabb.maxY,
        });

        // abort creation if colliding with another entity
        for (const food_cell of food_cells) {
          for (const entity_uuid of this.grid.get(food_cell)!) {
            const entity = parse_cell_uuid(entity_uuid);
            switch (entity.type) {
              case EntityType.PLAYER: {
                continue;
              }
              case EntityType.WORLD_OBJECT: {
                continue;
              }
            }
          }
        }
      }
    }

    const food = {
      x: Math.random() * WORLD_RADIUS,
      y: Math.random() * WORLD_RADIUS,
      r: INITIAL_PLAYER_RADIUS,
    };
    this.entities.set(food.uuid, food);
  }

  private _updateCells() {
    for (const [player_uuid, player] of this.players.entries()) {
      for (const [blob_index, blob] of player.blobs.entries()) {
        const blob_cells = this._cellsIntersectingAabb({
          minX: blob.minX,
          minY: blob.minY,
          maxX: blob.maxX,
          maxY: blob.maxY,
        });
        let unchanged = true;
        if (blob._cells.size !== blob_cells.size) unchanged = false;
        const blob_uuid = stringify_cell_uuid({
          type: EntityType.PLAYER,
          uuid: player_uuid,
          blob_index,
        });
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
      if (this.joining_players.has(player_uuid)) continue;

      const other_blobs: Record<
        string,
        z.infer<typeof tick_update_response_schema>["data"]["other_blobs"][number]
      > = {};

      // @TODO: send these players to the client for caching, using difference
      const players_in_vision_cells = new Set<PlayerUUID>();
      const vision_cells = this._cellsIntersectingAabb({
        minX: player.vision_minX,
        minY: player.vision_minY,
        maxX: player.vision_maxX,
        maxY: player.vision_maxY,
      });
      vision_cells.forEach((c) => {
        this.grid.get(c)?.forEach((cell_uuid_string) => {
          const cell_uuid = parse_cell_uuid(cell_uuid_string);
          switch (cell_uuid.type) {
            case EntityType.PLAYER: {
              if (cell_uuid.uuid === player_uuid) return;

              players_in_vision_cells.add(cell_uuid.uuid);

              if (this.joining_players.has(cell_uuid.uuid)) return;

              const blob = this.players.get(cell_uuid.uuid)!.blobs[cell_uuid.blob_index]!;
              if (
                blob.x >= player.vision_minX &&
                blob.x <= player.vision_maxX &&
                blob.y >= player.vision_minY &&
                blob.y <= player.vision_maxY
              ) {
                other_blobs[cell_uuid_string] = {
                  x: blob.x,
                  y: blob.y,
                  r: blob.r,
                  vx: blob.vx,
                  vy: blob.vy,
                };
              }
              break;
            }
            case EntityType.WORLD_OBJECT: {
              // @TODO: handle entities
              break;
            }
          }
        });
      });

      jobs.push(
        pubClient.publish(
          `player:${player_uuid}`,
          Kstringify({
            method: "tick_update",
            data: {
              com_x: player.com_x,
              com_y: player.com_y,
              self_blobs: player.blobs.map((blob) => ({
                x: blob.x,
                y: blob.y,
                r: blob.r,
              })),
              zoom_factor: player.zoom_factor,
              other_blobs,
            },
          } satisfies z.infer<typeof internal_tick_update_response_schema>),
        ),
      );
    }
    await Promise.all(jobs);
  }

  private async _tick(dt: number) {
    // global_logger.info("Tick started", performance.now());
    await this._updatePlayerPositions(dt);
    // global_logger.info("player positions updated", performance.now());
    this._updateCells();
    // global_logger.info("player cells updated", performance.now());
    await this._broadcastTickUpdate();
    // global_logger.info("tick update broadcasted", performance.now());
  }

  private async _startTickLoop(prev_tick_time: number) {
    const tick_start_time = performance.now();
    const dt = Math.min(0.01, (tick_start_time - prev_tick_time) / 1000); // clamp dt to 50ms
    await this._tick(dt);
    const elapsed = performance.now() - tick_start_time;
    const target = 1000 / TPS;
    const delay = Math.max(0, target - elapsed);
    setTimeout(() => this._startTickLoop(tick_start_time), delay);
  }
}
