import type {
    KSolanaNativeTokenMetadata,
    KSupportedNetworks,
    KSupportedSolanaExtensions,
    KTokenMetadata,
} from "@kasssandra/kassspay";
import type { KSolanaNativeTokenExtentions } from "@kasssandra/kassspay";
import {
    SOLANA_TOKEN_V1_ADDRESS,
    SPLExtensionMetadataSchema,
    SPLTokenAccountSchema,
    SPLTokenTransferInstructionSchema,
} from "./stores";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import { db } from "../kassspay-connections/database";
import {
    NativeToken,
    Token,
    TokenLogo,
} from "../kassspay-connections/database/schema";
import { and, eq } from "drizzle-orm";
import { Address } from "../kassspay-connections/database/schema";
import { address, address as SolanaAddress } from "@solana/kit";
import { solanaRPC } from "../kassspay-connections/solana";
import { fetchTokenMetadata } from "./tokenMetadata";
import { getsertExternalAddress } from "../kassspay-connections/database/utils/tx/getsertExternalAddress";
import { KNetworkToAddressKind } from "@kasssandra/kassspay";

export const getsertSolanaToken = async ({
    network,
    instruction_parsed,
    rpc,
}: {
    network: Extract<KSupportedNetworks, "solana" | "solana devnet">;
    instruction_parsed: z.infer<typeof SPLTokenTransferInstructionSchema>;
    rpc: typeof solanaRPC;
}): Promise<{
    token_id: number;
    native_token_id: number;
    address_id: number;
    native_token_precision: number;
    default_precision: number;
    kn_managed: boolean;
} | null> => {
    // check if the token exists in the database
    const token_lookup = await db
        .select({
            token_id: Token.id,
            native_token_id: NativeToken.id,
            address_id: Address.id,
            native_token_precision: NativeToken.token_precision,
            default_precision: Token.default_precision,
            kn_managed: Token.kn_managed,
        })
        .from(NativeToken)
        .innerJoin(Token, eq(Token.id, NativeToken.token_id))
        .innerJoin(Address, eq(Address.id, NativeToken.address_id))
        .where(
            and(
                eq(NativeToken.network_name, network),
                eq(Address.public_address, instruction_parsed.parsed.info.mint)
            )
        )
        .for("update");

    // token does not exist, create one
    if (token_lookup.length === 0) {
        const native_token_info_lookup = await rpc
            .getAccountInfo(
                SolanaAddress(instruction_parsed.parsed.info.mint),
                {
                    commitment: "finalized",
                    encoding: "jsonParsed",
                }
            )
            .send();

        const native_token_info_parsed = SPLTokenAccountSchema.safeParse(
            native_token_info_lookup.value
        );

        if (!native_token_info_parsed.success) {
            Sentry.captureException("Native token info parse failed", {
                level: "error",
                extra: {
                    native_token_info_lookup,
                    native_token_info_parsed,
                },
            });
            return null;
        }

        let token_kn_manageable = true;
        let native_token_metadata: KSolanaNativeTokenMetadata = {
            program_id:
                instruction_parsed.programId === SOLANA_TOKEN_V1_ADDRESS
                    ? "spl-token"
                    : "spl-token-2022",
            freeze_authority:
                native_token_info_parsed.data.data.parsed.info.freezeAuthority,
            mint_authority:
                native_token_info_parsed.data.data.parsed.info.mintAuthority,
            extensions: {},
        };

        if (native_token_info_parsed.data.data.parsed.info.extensions) {
            for (const extension of native_token_info_parsed.data.data.parsed
                .info.extensions) {
                switch (
                    extension.extension as (typeof KSupportedSolanaExtensions)[number]
                ) {
                    case "ImmutableOwner":
                        native_token_metadata.extensions.ImmutableOwner = {};
                        break;
                    case "CpiGuard":
                        native_token_metadata.extensions.CpiGuard = {};
                        break;
                    case "TokenMetadata":
                        const token_metadata_parsed =
                            SPLExtensionMetadataSchema.parse(extension);
                        native_token_metadata.extensions.TokenMetadata = {
                            name: token_metadata_parsed.name,
                            symbol: token_metadata_parsed.symbol,
                            update_authority:
                                token_metadata_parsed.updateAuthority,
                            uri: token_metadata_parsed.uri,
                        } as KSolanaNativeTokenExtentions.TokenMetadata;
                        break;
                    default:
                        // unsupported extension
                        token_kn_manageable = false;
                        break;
                }
            }
        }

        const fetched_token_metadata = await fetchTokenMetadata(
            rpc,
            native_token_metadata.extensions.TokenMetadata as
                | KSolanaNativeTokenExtentions.TokenMetadata
                | undefined,
            instruction_parsed.parsed.info.mint
        );

        let light_logo_id: number | null = null;
        let dark_logo_id: number | null = null;

        if (fetched_token_metadata.light_uri) {
            const light_logo_lookup = await db
                .insert(TokenLogo)
                .values({
                    uri: fetched_token_metadata.light_uri,
                })
                .returning({
                    id: TokenLogo.id,
                });
            light_logo_id = light_logo_lookup[0]?.id ?? null;
        }

        if (fetched_token_metadata.dark_uri) {
            const dark_logo_lookup = await db
                .insert(TokenLogo)
                .values({
                    uri: fetched_token_metadata.dark_uri,
                })
                .returning({
                    id: TokenLogo.id,
                });
            dark_logo_id = dark_logo_lookup[0]?.id ?? null;
        }

        // insert the token and mint address in the db
        const [token, mint_address] = await Promise.all([
            db
                .insert(Token)
                .values({
                    name: fetched_token_metadata.name,
                    description: fetched_token_metadata.description,
                    default_precision:
                        native_token_info_parsed.data.data.parsed.info.decimals,
                    ticker: fetched_token_metadata.ticker,
                    kn_managed: token_kn_manageable,
                    light_logo_id,
                    dark_logo_id,
                    verification_status: "unverified",
                })
                .returning({
                    id: Token.id,
                }),
            getsertExternalAddress(
                instruction_parsed.parsed.info.mint,
                KNetworkToAddressKind(network)
            ),
        ]);

        if (mint_address.kn_managed) {
            Sentry.captureException(
                "KN generated address may have been compromised, solana token was created on a kn managed address",
                {
                    level: "fatal",
                    extra: {
                        address,
                        network,
                        instruction_parsed,
                    },
                }
            );
            return null;
        }

        // insert the native token in the db
        const native_token = await db
            .insert(NativeToken)
            .values({
                network_name: network,
                address_id: mint_address.id,
                token_id: token[0]!.id,
                token_precision:
                    native_token_info_parsed.data.data.parsed.info.decimals,
            })
            .returning({
                id: NativeToken.id,
            });

        // lock the rows for the token
        await Promise.all([
            await db
                .select()
                .from(NativeToken)
                .where(eq(NativeToken.token_id, token[0]!.id))
                .for("update"),
            await db
                .select()
                .from(Token)
                .where(eq(Token.id, token[0]!.id))
                .for("update"),
        ]);

        return {
            token_id: token[0]!.id,
            native_token_id: native_token[0]!.id,
            address_id: mint_address.id,
            native_token_precision:
                native_token_info_parsed.data.data.parsed.info.decimals,
            default_precision:
                native_token_info_parsed.data.data.parsed.info.decimals,
            kn_managed: token_kn_manageable,
        };
    } else if (token_lookup[0] != undefined && token_lookup.length === 1) {
        return token_lookup[0];
    } else {
        Sentry.captureException("Multiple tokens found for the same mint", {
            level: "fatal",
            extra: {
                token_lookup,
                instruction_parsed,
                network,
            },
        });
        return null;
    }
};
