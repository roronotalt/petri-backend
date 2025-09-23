import { db } from "../../index";
import * as schema from "../../schema";
import { largest_address_index, RESERVED_ADDRESSES } from ".";

export const reserveAddresses = async () => {
    // Create all records in memory first
    const records = Array.from(
        { length: RESERVED_ADDRESSES - largest_address_index },
        (_, index) => ({
            public_address: `reserved_${largest_address_index + index}`,
            address_kind: "kasssandra" as const,
            kn_managed: false,
            id: largest_address_index + index,
        })
    );

    // Insert all records in a single batch operation
    await db.insert(schema.Address).values(records).onConflictDoNothing();
};
