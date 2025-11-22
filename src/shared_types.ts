import { z } from "zod";

/* eslint-disable @typescript-eslint/naming-convention */
export const CLIENT_WIDTH_PIXELS = 1920;
export const CLIENT_HEIGHT_PIXELS = 1080;
/* eslint-enable @typescript-eslint/naming-convention */

export enum Entity {
  PLAYER_BLOB,
  FOOD,
  VIRUS,
}

/**
 * Entity types
 *
 * @remarks
 *   Value is used in entity uuid generation and parsing
 */
export enum EntityType {
  PLAYER_BLOB,
  WORLD_OBJECT,
}

export const bounding_box_schema = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number(),
});

/** Entity type UUID */
export const entity_type_uuid_schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(EntityType.PLAYER_BLOB),
    uuid: z.string().uuid(),
    blob_index: z.number(),
  }),
  z.object({
    type: z.literal(EntityType.WORLD_OBJECT),
    uuid: z.string().uuid(),
  }),
]);

export const food_schema = z.object({
  type: z.literal(Entity.FOOD),
  x: z.number(),
  y: z.number(),
  r: z.number(),
});

export const virus_schema = z.object({
  type: z.literal(Entity.VIRUS),
  x: z.number(),
  y: z.number(),
  r: z.number(),
});

export const world_object_schema = z.discriminatedUnion("type", [food_schema, virus_schema]);

export const world_objects_schema = z.array(z.tuple([z.string(), world_object_schema]));

export const self_blobs_schema = z.array(
  z.object({
    x: z.number(),
    y: z.number(),
    r: z.number(),
  }),
);

export const other_blob_schema = z.object({
  x: z.number(),
  y: z.number(),
  r: z.number(),
  vx: z.number(),
  vy: z.number(),
});

export const other_blobs_schema = z.array(z.tuple([z.string(), other_blob_schema]));

export const tick_update_response_schema = z.object({
  method: z.literal("tick_update"),
  data: z.object({
    com_x: z.number(),
    com_y: z.number(),
    zoom_factor: z.number(),
    world_radius: z.number(),
    self_blobs: self_blobs_schema,
    other_blobs: other_blobs_schema,
    world_objects: world_objects_schema,
  }),
});

export const join_game_response_schema = z.object({
  method: z.literal("join_game"),
  data: tick_update_response_schema.shape.data,
});

export const server_responses_schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("success"),
    id: z.string().max(100),
    data: z.discriminatedUnion("method", [join_game_response_schema, tick_update_response_schema]),
  }),
  z.object({
    type: z.literal("error"),
    id: z.string().max(100).nullable(),
    error: z.object({
      code: z.number(),
      message: z.string(),
    }),
  }),
]);

export const client_update_position_schema = z.object({
  client_heartbeat: z
    .number()
    .refine((val) => Date.now() - val < 5_000, { message: "Heartbeat must be in the past" }),
  x: z.number(),
  y: z.number(),
});

export const client_join_game_schema = z.object({
  name: z.string().max(100),
  secret_key: z.string().max(256),
});

export const server_methods_schema = z.discriminatedUnion("method", [
  z.object({
    id: z.string().max(100),
    method: z.literal("join_game"),
    params: client_join_game_schema,
  }),
  z.object({
    method: z.literal("update_position"),
    params: client_update_position_schema,
  }),
]);
