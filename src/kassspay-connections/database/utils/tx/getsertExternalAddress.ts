import { KAddressKinds } from "@kasssandra/kassspay";
import { db } from "../..";
import { Address } from "../../schema";
import { and, eq } from "drizzle-orm";
import * as Sentry from "@sentry/node";

export const getsertExternalAddress = async (
    public_address: string,
    address_kind: KAddressKinds
): Promise<{
    id: number;
    kn_managed: boolean;
}> => {
    const address = await db.query.Address.findFirst({
        where: and(
            eq(Address.public_address, public_address),
            eq(Address.address_kind, address_kind)
        ),
        columns: {
            id: true,
            kn_managed: true,
        },
    });

    if (address == undefined) {
        return await (
            await db
                .insert(Address)
                .values({
                    public_address: public_address,
                    address_kind: address_kind,
                    user_managed_at: new Date(),
                    kn_managed: false,
                })
                .returning({
                    id: Address.id,
                    kn_managed: Address.kn_managed,
                })
        )[0];
    }
    return address;
};
