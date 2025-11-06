import type { Worker } from "bun";
import { pubClient } from "./petri-connections";
import { z } from "zod";
import { Kstringify } from "@kasssandra/kassspay";
import { player_backup_data_schema } from "./stores";
declare const self: Worker;

self.onmessage = async (event: MessageEvent) => {
   // save a backup of the player data
   await pubClient.set(
      `player:backup:${event.data.uuid}`,
      Kstringify({
         x: event.data.x,
         y: event.data.y,
         r: event.data.r,
         angle: event.data.angle,
         magnitude: event.data.magnitude,
      } satisfies z.infer<typeof player_backup_data_schema>),
   );
};
