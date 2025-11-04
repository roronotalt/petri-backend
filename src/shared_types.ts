import { z } from "zod";

export const join_game_response_schema = z.object({
   method: z.literal("join_game"),
   data: z.object({
      x: z.number(),
      y: z.number(),
      r: z.number(),
      world_r: z.number(),
   }),
});

export const tick_update_response_schema = z.object({
   method: z.literal("tick_update"),
   data: z.object({
      relative_positions: z.array(
         z.object({
            uuid: z.string(),
            x: z.number(),
            y: z.number(),
            r: z.number(),
            angle: z.number(),
            magnitude: z.number(),
         }),
      ),
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

export const client_update_vector_schema = z.object({
   secret_key: z.string().max(256),
   client_heartbeat: z
      .number()
      .refine((val) => val <= Date.now(), { message: "Heartbeat must be in the past" }),
   angle: z.number(),
   magnitude: z.number(),
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
      id: z.string().max(100),
      method: z.literal("update_vector"),
      params: client_update_vector_schema,
   }),
]);
