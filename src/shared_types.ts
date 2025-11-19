import { z } from "zod";

/* eslint-disable @typescript-eslint/naming-convention */
export const CLIENT_WIDTH_PIXELS = 1920;
export const CLIENT_HEIGHT_PIXELS = 1080;
/* eslint-enable @typescript-eslint/naming-convention */

export const world_border_schema = z.array(z.tuple([z.number(), z.number()]));

export const join_game_response_schema = z.object({
   method: z.literal("join_game"),
   data: z.object({
      x: z.number(),
      y: z.number(),
      r: z.number(),
      world_border: world_border_schema,
      zoom_factor: z.number(),
   }),
});

export const self_blobs_schema = z.array(
   z.object({
      x: z.number(),
      y: z.number(),
      r: z.number(),
   }),
);

export const other_blobs_schema = z.record(
   z.string(),
   z.object({
      x: z.number(),
      y: z.number(),
      r: z.number(),
      vx: z.number(),
      vy: z.number(),
   }),
);

export const tick_update_response_schema = z.object({
   method: z.literal("tick_update"),
   data: z.object({
      com_x: z.number(),
      com_y: z.number(),
      zoom_factor: z.number(),
      world_border: world_border_schema,
      self_blobs: self_blobs_schema,
      other_blobs: other_blobs_schema,
   }),
});

export const server_responses_schema = z.discriminatedUnion("type", [
   z.object({
      type: z.literal("success"),
      id: z.string().max(100),
      data: z.discriminatedUnion("method", [
         join_game_response_schema,
         tick_update_response_schema,
      ]),
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
      .refine((val) => val <= Date.now(), { message: "Heartbeat must be in the past" }),
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

export const food_schema = z.object({
   type: z.literal("food"),
   x: z.number(),
   y: z.number(),
   r: z.number(),
});

export const virus_schema = z.object({
   type: z.literal("virus"),
   x: z.number(),
   y: z.number(),
   r: z.number(),
});

export const world_object_schema = z.discriminatedUnion("type", [food_schema, virus_schema]);
