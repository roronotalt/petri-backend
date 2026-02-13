import { z } from "zod";
import { pubClient, subClient } from "./petri-connections";
import {
  type join_game_response_schema,
  type tick_update_response_schema,
  bounding_box_schema,
  CLIENT_HEIGHT_PIXELS,
  CLIENT_WIDTH_PIXELS,
  Entity,
  entity_type_uuid_schema,
  EntityType,
  other_blob_schema,
  other_blobs_schema,
  world_object_schema,
  world_objects_schema,
} from "./shared_types";
import {
  calculate_aabb,
  global_logger,
  GRID_CELL_SIZE,
  INITIAL_PLAYER_RADIUS,
  internal_join_game_response_schema,
  internal_tick_update_response_schema,
  MAXIMUM_FOOD_RADIUS,
  MAXIMUM_FOOD_SPAWNING_ATTEMPTS,
  MIN_SEPERATION_DISTANCE,
  MINIMUM_FOOD_RADIUS,
  player_metadata_schema,
  player_update_position_schema,
  sweeping_aabb,
  TPS,
  WORLD_RADIUS,
  SCALE_BASE,
  type BoundingBox,
} from "./stores";
import { Kparse, Kstringify } from "@kasssandra/kassspay";

const game_server_logger = global_logger.child_logger({ name: "game-server" });

type Blob = {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  aabb: BoundingBox;
  _cells: Set<bigint>;
};

/** Server player object */
type Player = {
  blobs: Blob[];
  client_x: number;
  client_y: number;
  com_x: number;
  com_y: number;
  vision_aabb: BoundingBox;
  zoom_factor: number;
  _player_cache: string[];
};

type ServerWorldObject = z.infer<typeof world_object_schema> & {
  aabb: z.infer<typeof bounding_box_schema>;
} & { _cells: Set<bigint> };

/**
 * @param entity_uuid Entity uuid object
 * @returns Stringified entity uuid
 */
const stringify_entity_type_uuid = (
  entity_uuid: z.infer<typeof entity_type_uuid_schema>,
): string => {
  if (entity_uuid.type === EntityType.PLAYER_BLOB)
    return `${entity_uuid.uuid}:${entity_uuid.blob_index}`;
  return `${entity_uuid.uuid}`;
};

/**
 * @param entity_uuid Cell uuid string
 * @returns Entity uuid object
 */
const parse_entity_type_uuid = (entity_uuid: string): z.infer<typeof entity_type_uuid_schema> => {
  const [uuid, blob_index] = entity_uuid.split(":") as [string, string | undefined];
  if (blob_index === undefined) {
    return { type: EntityType.WORLD_OBJECT, uuid };
  }
  return { type: EntityType.PLAYER_BLOB, uuid, blob_index: parseInt(blob_index) };
};

type PlayerUUID = string;
type WorldObjectUUID = string;

export class ServerGameState {
  /**
   * Grid of cells, indexed by their hash each cell contains a set of formatted uuids for either a
   * blob (player_uuid:blob_index) or an entity (uuid) we use uuids for players and entities to
   * avoid collisions between them, even though it's one in a quintillion chance
   *
   * @see EntityUUID
   */
  private readonly grid: Map<bigint, Set<string>>;
  /** Players in the game, indexed by their UUID */
  private readonly players = new Map<PlayerUUID, Player>();
  private readonly world_objects = new Map<WorldObjectUUID, ServerWorldObject>();
  /**
   * Players that are joining the game (yet to be inserted into the players map), indexed by their
   * UUID
   */
  private readonly spawning_players = new Set<PlayerUUID>();
  /** Amount of food in the game, in cents */
  private food_amount = 0;

  constructor() {
    this.grid = new Map<bigint, Set<string>>();
  }

  /**
   * Hashes cell using coordinate
   *
   * @param cx X-coordinate
   * @param cy Y-coordinate
   * @returns 32 bit hash of the cell coordinate
   */
  private static _hashCell(cx: number, cy: number): bigint {
    const x = BigInt(cx) & 0xffffffffn;
    const y = BigInt(cy) & 0xffffffffn;
    return (x << 32n) | y;
  }

  /**
   * Dehashes cell using cell hash
   *
   * @param hash Cell hash computed with _hashCell
   * @returns Coordinate
   * @see _hashCell
   */
  private static _unhashCell(hash: bigint): { x: number; y: number } {
    const raw_x = (hash >> 32n) & 0xffffffffn;
    const raw_y = hash & 0xffffffffn;

    return {
      x: Number((raw_x ^ 0x80000000n) - 0x80000000n),
      y: Number((raw_y ^ 0x80000000n) - 0x80000000n),
    };
  }

  /**
   * Calculates player scale based on radius
   *
   * @remarks
   *   Counts on intitial player radius being minium
   * @param r Player radius
   * @returns Player vision scalar
   * @see INITIAL_PLAYER_RADIUS
   */
  private static _calculatePlayerScale(r: number): number {
    return Math.log(r) / 100 + 0.03;
  }

  /**
   * @param a Arbitrary bounding box
   * @param b Arbitrary bounding box
   * @returns True if a and b overlap
   */
  private static _overlaps(a: BoundingBox, b: BoundingBox): boolean {
    return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
  }

  /**
   * Calculate cell hashes that intersect with bounding box
   *
   * @param bounding_box Arbitrary bounding box
   * @returns Cell hashes
   */
  private _cellsIntersectingAabb(bounding_box: BoundingBox): Set<bigint> {
    const cx1 = Math.floor(bounding_box.minX / GRID_CELL_SIZE);
    const cy1 = Math.floor(bounding_box.minY / GRID_CELL_SIZE);
    const cx2 = Math.floor(bounding_box.maxX / GRID_CELL_SIZE);
    const cy2 = Math.floor(bounding_box.maxY / GRID_CELL_SIZE);

    const cells = new Set<bigint>();
    for (let cy = cy1; cy <= cy2; cy++) {
      for (let cx = cx1; cx <= cx2; cx++) {
        cells.add(ServerGameState._hashCell(cx, cy));
      }
    }
    return cells;
  }

  /**
   * Searchs for random collision-free location for an entity.
   *
   * @remarks
   *   Radius must be smaller than GRID_CELL_SIZE - MIN_SEPERATION_DISTANCE
   * @param radius - Radius of the entity to spawn
   * @param max_attempts - Maximum number of attempts before returning with success false
   * @param entity - Different logic for different entitity collision checking
   * @returns Location information (formatted for spreading) and cell(s) if successful within
   *   attempts
   * @see GRID_CELL_SIZE
   * @see MIN_SEPERATION_DISTANCE
   */
  private _randomCollisionFreeLocation(
    radius: number,
    max_attempts: number,
    entity: Entity,
  ):
    | {
        success: true;
        location: { x: number; y: number; _cells: Set<bigint>; aabb: BoundingBox };
      }
    | {
        success: false;
      } {
    let attempts = 0;
    let empty_cell_hash: bigint | undefined = undefined;
    let aabb: BoundingBox;

    collision_free_attempt: while (attempts < max_attempts) {
      attempts++;

      if (empty_cell_hash !== undefined) {
        const cell = ServerGameState._unhashCell(empty_cell_hash);
        const x =
          cell.x +
          Math.random() * (GRID_CELL_SIZE - MIN_SEPERATION_DISTANCE) +
          MIN_SEPERATION_DISTANCE;
        const y =
          cell.y +
          Math.random() * (GRID_CELL_SIZE - MIN_SEPERATION_DISTANCE) +
          MIN_SEPERATION_DISTANCE;

        // ensure entity is within world border
        if (Math.abs(x) > WORLD_RADIUS - radius || Math.abs(y) > WORLD_RADIUS - radius) {
          empty_cell_hash = undefined;
          attempts--;
          continue collision_free_attempt;
        }

        return {
          success: true,
          location: { aabb: aabb!, x, y, _cells: new Set([empty_cell_hash]) },
        };
      }

      const ajusted_world_diameter = 2 * WORLD_RADIUS - radius;
      const x = ajusted_world_diameter * Math.random() - ajusted_world_diameter / 2;
      const y = ajusted_world_diameter * Math.random() - ajusted_world_diameter / 2;

      aabb = calculate_aabb(
        x,
        y,
        radius + MIN_SEPERATION_DISTANCE,
        radius + MIN_SEPERATION_DISTANCE,
      );

      const cell_hashes = this._cellsIntersectingAabb(aabb);

      for (const cell_hash of cell_hashes) {
        const cell = this.grid.get(cell_hash);
        // flag empty cell for next attempt but continue checking this coordinate
        if (cell === undefined) {
          empty_cell_hash = cell_hash;
          continue;
        }

        for (const unparsed_entity_uuid of cell) {
          const entity_uuid = parse_entity_type_uuid(unparsed_entity_uuid);

          if (entity_uuid.type === EntityType.PLAYER_BLOB) {
            const blob = this.players.get(entity_uuid.uuid)!.blobs[entity_uuid.blob_index]!;
            if (ServerGameState._overlaps(blob.aabb, aabb)) {
              continue collision_free_attempt;
            }
            continue;
          }

          const world_object = this.world_objects.get(entity_uuid.uuid)!;

          // if the entity type is a player then do not worry about spawning them in with collisions with food
          if (
            entity == Entity.PLAYER_BLOB &&
            entity_uuid.type === EntityType.WORLD_OBJECT &&
            world_object.type === Entity.FOOD
          ) {
            continue;
          }

          if (ServerGameState._overlaps(world_object.aabb, aabb)) {
            continue collision_free_attempt;
          }
        }
      }

      return {
        success: true,
        location: { aabb, x, y, _cells: cell_hashes },
      };
    }
    return {
      success: false,
    };
  }

  /**
   * Get all visible entities for a player (excluding players' own entities)
   *
   * @param player_uuid Player uuid string
   * @returns World_objects, other_blobs, and player metadata
   */
  private _visibleEntities(player_uuid: PlayerUUID): {
    other_blobs: z.infer<typeof other_blobs_schema>;
    world_objects: z.infer<typeof world_objects_schema>;
    player_metadata: Set<PlayerUUID>;
  } {
    const player = this.players.get(player_uuid)!;
    const visible_other_blobs_uuid = new Set<string>();
    const visible_other_blobs: z.infer<typeof other_blob_schema>[] = [];
    const visible_world_objects_uuid = new Set<string>();
    const visible_world_objects: z.infer<typeof world_object_schema>[] = [];

    const vision_cells = this._cellsIntersectingAabb(player.vision_aabb);

    // @TODO: send these players to the client for caching, using difference
    const player_metadata = new Set<PlayerUUID>();
    vision_cells.forEach((cell_hash) => {
      for (const entity_uuid_string of this.grid.get(cell_hash) ?? []) {
        const entity_uuid = parse_entity_type_uuid(entity_uuid_string);
        switch (entity_uuid.type) {
          case EntityType.PLAYER_BLOB: {
            if (visible_other_blobs_uuid.has(entity_uuid.uuid)) continue;
            if (entity_uuid.uuid === player_uuid) continue;

            const other_player = this.players.get(entity_uuid.uuid);

            if (other_player === undefined) {
              game_server_logger.warn(`Player ${entity_uuid.uuid} not found`);
              continue;
            }

            const blob = other_player.blobs[entity_uuid.blob_index];
            player_metadata.add(entity_uuid.uuid);

            if (blob === undefined) {
              game_server_logger.warn(
                `Blob ${entity_uuid.blob_index} not found for player ${entity_uuid.uuid}`,
              );
              continue;
            }

            if (!ServerGameState._overlaps(player.vision_aabb, blob.aabb)) continue;

            visible_other_blobs_uuid.add(entity_uuid.uuid);
            visible_other_blobs.push({
              x: blob.x,
              y: blob.y,
              r: blob.r,
              vx: blob.vx,
              vy: blob.vy,
            });
            break;
          }
          case EntityType.WORLD_OBJECT: {
            if (visible_world_objects_uuid.has(entity_uuid.uuid)) continue;
            const world_object = this.world_objects.get(entity_uuid.uuid);
            if (!world_object) {
              game_server_logger.warn(
                `World object ${entity_uuid.uuid} not found for player ${entity_uuid.uuid}`,
              );
              continue;
            }

            if (!ServerGameState._overlaps(player.vision_aabb, world_object.aabb)) continue;

            visible_world_objects_uuid.add(entity_uuid.uuid);
            visible_world_objects.push({
              type: world_object.type,
              x: world_object.x,
              y: world_object.y,
              r: world_object.r,
            });
            break;
          }
        }
      }
    });

    const other_blobs: z.infer<typeof other_blobs_schema> = [];
    let i = 0;

    for (const uuid of visible_other_blobs_uuid) {
      other_blobs.push([uuid, visible_other_blobs[i]!]);
      i++;
    }

    const world_objects: z.infer<typeof world_objects_schema> = [];

    i = 0;
    for (const uuid of visible_world_objects_uuid) {
      world_objects.push([uuid, visible_world_objects[i]!]);
      i++;
    }

    return {
      other_blobs,
      world_objects,
      player_metadata,
    };
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

      // add player to spawning player queue
      this.spawning_players.add(player.data.uuid);
    });
  }

  /** Spawns new players into the game and adds their value to the food pile */
  private async _spawnPlayer() {
    const jobs: Promise<unknown>[] = [];
    for (const player_uuid of this.spawning_players) {
      const starting_location = this._randomCollisionFreeLocation(
        INITIAL_PLAYER_RADIUS,
        5,
        Entity.PLAYER_BLOB,
      );

      if (!starting_location.success) {
        global_logger.error(`Failed to find a collision-free location for player ${player_uuid}`);
        continue;
      }
      const zoom_factor = ServerGameState._calculatePlayerScale(INITIAL_PLAYER_RADIUS);

      const vision_aabb = calculate_aabb(
        starting_location.location.x,
        starting_location.location.y,
        (CLIENT_WIDTH_PIXELS / 2) * zoom_factor,
        (CLIENT_HEIGHT_PIXELS / 2) * zoom_factor,
      );

      this.players.set(player_uuid, {
        blobs: [
          {
            ...starting_location.location,
            r: INITIAL_PLAYER_RADIUS,
            vx: 0,
            vy: 0,
          },
        ],
        client_x: CLIENT_WIDTH_PIXELS / 2,
        client_y: CLIENT_HEIGHT_PIXELS / 2,
        com_x: starting_location.location.x,
        com_y: starting_location.location.y,
        vision_aabb,
        zoom_factor: zoom_factor,
        _player_cache: [],
      });

      const visible_entries = this._visibleEntities(player_uuid);

      this.spawning_players.delete(player_uuid);
      // @TODO: handle food amount dynamic
      this.food_amount += 100;

      jobs.push(
        pubClient.publish(
          `player:${player_uuid}`,
          Kstringify({
            method: "join_game",
            data: {
              self_blobs: [
                {
                  x: starting_location.location.x,
                  y: starting_location.location.y,
                  r: INITIAL_PLAYER_RADIUS,
                },
              ],
              com_x: starting_location.location.x,
              com_y: starting_location.location.y,
              world_radius: WORLD_RADIUS,
              other_blobs: visible_entries.other_blobs,
              world_objects: visible_entries.world_objects,
              zoom_factor: zoom_factor,
            },
          } satisfies z.infer<typeof internal_join_game_response_schema>),
        ),
      );
    }
    await Promise.all(jobs);
  }

  private _spawnFood() {
    let total_food_spawning_radius = this.food_amount - Math.log(this.food_amount + 1);
    this.food_amount -= total_food_spawning_radius;

    let failures = 0;

    while (
      total_food_spawning_radius > MINIMUM_FOOD_RADIUS &&
      failures < MAXIMUM_FOOD_SPAWNING_ATTEMPTS
    ) {
      const food_radius =
        MINIMUM_FOOD_RADIUS + Math.random() * (MAXIMUM_FOOD_RADIUS - MINIMUM_FOOD_RADIUS);
      total_food_spawning_radius -= food_radius;

      const collision_free_location = this._randomCollisionFreeLocation(
        food_radius,
        3,
        Entity.FOOD,
      );

      if (!collision_free_location.success) {
        if (failures > MAXIMUM_FOOD_SPAWNING_ATTEMPTS) {
          game_server_logger.warn(`Maximum FOOD spawning attemps reached, food spawning failed`);
        }
        failures++;
        continue;
      }

      const food_uuid = crypto.randomUUID();
      this.world_objects.set(food_uuid, {
        ...collision_free_location.location,
        r: food_radius,
        type: Entity.FOOD,
      });
      collision_free_location.location._cells.forEach((cell_hash) => {
        let cell = this.grid.get(cell_hash);
        if (!cell) this.grid.set(cell_hash, (cell = new Set<string>()));
        cell.add(food_uuid);
      });
    }
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
        player.client_x = (update_position.data.x - CLIENT_WIDTH_PIXELS / 2) * player.zoom_factor;
        player.client_y = (update_position.data.y - CLIENT_HEIGHT_PIXELS / 2) * player.zoom_factor;
      } catch {
        // player may have been deleted since the update position was sent; ignore
      }
    });
  }

  /**
   * Update a players com coordiantes, blob coordinates, and cells
   *
   * @param dt Delta time
   */
  private _updatePlayersLocations(dt: number) {
    for (const [player_uuid, player] of this.players.entries()) {
      let radius = 0,
        total_mass = 0,
        total_x = 0,
        total_y = 0;

      for (const [blob_index, blob] of player.blobs.entries()) {
        // update blob position
        const blob_world_x = player.com_x + player.client_x;
        const blob_world_y = player.com_y - player.client_y;
        let dx = blob_world_x - blob.x;
        let dy = blob_world_y - blob.y;

        const mass = blob.r * blob.r;
        const magnitude_sq = dx * dx + dy * dy;

        if (magnitude_sq != 0) {
          if (magnitude_sq > mass) {
            const n = blob.r / Math.sqrt(magnitude_sq);
            dx *= n;
            dy *= n;
          }
        }
        blob.x = Math.max(
          Math.min(blob.x + dx * dt * TPS, WORLD_RADIUS - blob.r),
          -WORLD_RADIUS + blob.r,
        );
        blob.y = Math.max(
          Math.min(blob.y + dy * dt * TPS, WORLD_RADIUS - blob.r),
          -WORLD_RADIUS + blob.r,
        );

        const blob_aabb = sweeping_aabb(blob.x, blob.y, blob.vx, blob.vy, blob.r, blob.r);
        blob.aabb = blob_aabb;

        // update variables updated to calculate COM
        total_x += blob.x * mass;
        total_y += blob.y * mass;
        radius += blob.r;
        total_mass += mass;

        // update cells for blob
        const blob_cells = this._cellsIntersectingAabb(blob_aabb);
        let unchanged = true;
        if (blob._cells.size !== blob_cells.size) unchanged = false;
        const blob_uuid = stringify_entity_type_uuid({
          type: EntityType.PLAYER_BLOB,
          uuid: player_uuid,
          blob_index,
        });
        blob._cells.difference(blob_cells).forEach((c) => {
          if (unchanged) {
            unchanged = false;
          }

          const old_cell = this.grid.get(c)!;
          old_cell.delete(blob_uuid);
          if (old_cell.size === 0) {
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

      player.zoom_factor = ServerGameState._calculatePlayerScale(radius);

      player.com_x = total_x / total_mass;
      player.com_y = total_y / total_mass;

      const vision_aabb = calculate_aabb(
        player.com_x,
        player.com_y,
        (CLIENT_WIDTH_PIXELS / 2) * player.zoom_factor,
        (CLIENT_HEIGHT_PIXELS / 2) * player.zoom_factor,
      );

      player.vision_aabb = vision_aabb;
    }
  }

  /** Collision logic */
  private _updateCollisions() {
    for (const [player_uuid, player] of this.players.entries()) {
      for (const [blob_index, blob] of player.blobs.entries()) {
        const blob_uuid = stringify_entity_type_uuid({
          type: EntityType.PLAYER_BLOB,
          blob_index,
          uuid: player_uuid,
        });
        for (const cell_hash of blob._cells) {
          const cell = this.grid.get(cell_hash)!;
          // remove the cell for there is no more reason to check collisions with it this tick
          cell.delete(blob_uuid);
          for (const entity_uuid of cell) {
            const entity = parse_entity_type_uuid(entity_uuid);
            switch (entity.type) {
              case EntityType.PLAYER_BLOB:
                const other_player = this.players.get(entity.uuid)!;
                if (other_player) {
                  // Handle collision logic here
                }
                break;
              case EntityType.WORLD_OBJECT:
                // @TODO
                break;
            }
          }
        }
      }
    }
  }

  private async _broadcastTickUpdate() {
    const jobs: Promise<unknown>[] = [];
    for (const [player_uuid, player] of this.players.entries()) {
      const { other_blobs, world_objects } = this._visibleEntities(player_uuid);

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
              world_objects,
              world_radius: WORLD_RADIUS,
            },
          } satisfies z.infer<typeof internal_tick_update_response_schema>),
        ),
      );
    }
    await Promise.all(jobs);
  }

  private async _tick(dt: number) {
    // global_logger.info("Tick started", performance.now());
    this._spawnFood();
    this._updatePlayersLocations(dt);
    // global_logger.info("player positions updated", performance.now());
    await Promise.all([this._spawnPlayer(), this._broadcastTickUpdate()]);
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
