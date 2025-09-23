import { db } from "../../index";
import { sql } from "drizzle-orm";
import { reserveAddresses } from "./reserveAddresses";
import { seedNetworks } from "./seedNetworks";
import { seedTokens } from "./seedTokens";

export let largest_address_index = 0;
export const incrementLargestAddressIndex = () => {
    largest_address_index++;
};

export const RESERVED_ADDRESSES = 15;

await seedNetworks();
await seedTokens();
await reserveAddresses();

// Ensure identity sequences are in sync with the highest explicit ids inserted during seeding
await Promise.all([
    db.execute(
        sql`SELECT setval(pg_get_serial_sequence('address','id'), COALESCE((SELECT MAX(id) FROM address), 1))`
    ),
    db.execute(
        sql`SELECT setval(pg_get_serial_sequence('network','id'), COALESCE((SELECT MAX(id) FROM network), 1))`
    ),
    db.execute(
        sql`SELECT setval(pg_get_serial_sequence('token_logo','id'), COALESCE((SELECT MAX(id) FROM token_logo), 1))`
    ),
    db.execute(
        sql`SELECT setval(pg_get_serial_sequence('token','id'), COALESCE((SELECT MAX(id) FROM token), 1))`
    ),
    db.execute(
        sql`SELECT setval(pg_get_serial_sequence('native_token','id'), COALESCE((SELECT MAX(id) FROM native_token), 1))`
    ),
]);

console.log("Successfully seeded database");
