import type { KSolanaNativeTokenExtentions } from "@kasssandra/kassspay";
import {
    address as SolanaAddress,
    getAddressEncoder,
    getProgramDerivedAddress,
} from "@solana/kit";
import { z } from "zod";
import type { solanaRPC } from "../kassspay-connections/solana";
import {
    getMetadataAccountDataSerializer,
    type MetadataAccountData,
    type MetadataAccountDataArgs,
} from "@metaplex-foundation/mpl-token-metadata";
import type { Serializer } from "@metaplex-foundation/umi/serializers";
import { MetaplexMetadataSchema } from "./stores";

const METAPLEX_PROGRAM_ADDRESS = SolanaAddress(
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);
const addressEncoder = getAddressEncoder();

const TokenMetadataURISchema = z.object({
    name: z.string(),
    symbol: z.string(),
    description: z.string(),
    image: z.string().nullish(),
    attributes: z
        .array(
            z.object({
                trait_type: z.string(),
                value: z.string(),
            })
        )
        .nullish(),
});

const unknown_token_metadata = {
    name: "Uknown",
    ticker: "UNKNOWN",
    description: null,
    light_uri: null,
    dark_uri: null,
};

type TokenMetadata = {
    name: string;
    ticker: string;
    description: string | null;
    light_uri: string | null;
    dark_uri: string | null;
};

const fetchTokenMetadataFromURI = async (
    uri: string
): Promise<TokenMetadata | undefined> => {
    if (uri === "") {
        return undefined;
    }

    try {
        const res = await fetch(uri);

        if (!res.ok) {
            return undefined;
        }

        const parsed_metadata = TokenMetadataURISchema.parse(await res.json());
        return {
            name: parsed_metadata.name,
            ticker: parsed_metadata.symbol,
            description: parsed_metadata.description,
            light_uri: parsed_metadata.image ?? null,
            dark_uri: parsed_metadata.image ?? null,
        };
    } catch (err) {
        // network failure or JSON parse error
        return undefined;
    }
};

// process token metadata so no empty names/symbols appear
const processTokenMetadata = (token_metadata: TokenMetadata): TokenMetadata => {
    const ticker =
        token_metadata.ticker === ""
            ? unknown_token_metadata.ticker
            : token_metadata.ticker;
    return {
        name: token_metadata.name === "" ? ticker : token_metadata.name,
        ticker: ticker,
        description:
            token_metadata.description === ""
                ? null
                : token_metadata.description,
        light_uri:
            token_metadata.light_uri === "" ? null : token_metadata.light_uri,
        dark_uri:
            token_metadata.dark_uri === "" ? null : token_metadata.dark_uri,
    };
};

// create a serializer for the Metadata account
const serializer: Serializer<MetadataAccountDataArgs, MetadataAccountData> =
    getMetadataAccountDataSerializer();

export const fetchTokenMetadata = async (
    rpc: typeof solanaRPC,
    token_metadata: KSolanaNativeTokenExtentions.TokenMetadata | undefined,
    token_address: string
): Promise<TokenMetadata> => {
    // try using the token metadata extension
    if (token_metadata) {
        let metadata: TokenMetadata = {
            name: token_metadata.name,
            ticker: token_metadata.symbol,
            description: unknown_token_metadata.description,
            light_uri: null,
            dark_uri: null,
        };

        // fetch metadata from URI, if it exists then use that instead
        await fetchTokenMetadataFromURI(token_metadata.uri).then(
            (uri_metadata) => {
                if (uri_metadata) {
                    metadata = uri_metadata;
                }
            }
        );

        return processTokenMetadata(metadata);
    }

    // fallback to metaplex
    const seeds = [
        "metadata", // auto-encoded as UTF-8 string
        addressEncoder.encode(METAPLEX_PROGRAM_ADDRESS), // 32-byte seed
        addressEncoder.encode(SolanaAddress(token_address)), // 32-byte seed
    ];

    const [metadata_address, _] = await getProgramDerivedAddress({
        programAddress: METAPLEX_PROGRAM_ADDRESS,
        seeds: seeds,
    });

    const res = await rpc
        .getAccountInfo(SolanaAddress(metadata_address), {
            commitment: "finalized",
            encoding: "jsonParsed",
        })
        .send();

    if (
        res.value?.data &&
        Array.isArray(res.value.data) &&
        res.value.data[1] === "base64"
    ) {
        const metaplex_metadata = MetaplexMetadataSchema.safeParse(
            serializer.deserialize(
                Uint8Array.from(Buffer.from(res.value.data[0], "base64"))
            )[0]
        );

        if (metaplex_metadata.success) {
            let metadata: TokenMetadata = {
                name: metaplex_metadata.data.name,
                ticker: metaplex_metadata.data.symbol,
                description: unknown_token_metadata.description,
                light_uri: null,
                dark_uri: null,
            };

            // fetch metadata from URI, if it exists then use that instead
            await fetchTokenMetadataFromURI(metaplex_metadata.data.uri).then(
                (uri_metadata) => {
                    if (uri_metadata) {
                        metadata = uri_metadata;
                    }
                }
            );

            return processTokenMetadata(metadata);
        }
    }
    return unknown_token_metadata;
};
