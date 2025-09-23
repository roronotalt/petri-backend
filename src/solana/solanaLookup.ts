import {
    Address,
    NativeToken,
    Token,
} from "../kassspay-connections/database/schema";
import { db } from "../kassspay-connections/database";
import { and, eq } from "drizzle-orm";
import type { KSupportedNetworks } from "@kasssandra/kassspay";

export const solanaLookup = async (network: KSupportedNetworks) => {
    return await db
        .select({
            token_id: Token.id,
            native_token_id: NativeToken.id,
            default_precision: Token.default_precision,
            native_token_precision: NativeToken.token_precision,
        })
        .from(Token)
        .innerJoin(NativeToken, eq(NativeToken.token_id, Token.id))
        .innerJoin(Address, eq(Address.id, NativeToken.address_id))
        .where(
            and(
                eq(NativeToken.network_name, network),
                eq(Token.ticker, "SOL"),
                eq(Token.verification_status, "verified")
            )
        );
};
