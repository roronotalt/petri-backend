import { address } from "@solana/kit";
import { z } from "zod";

export const SOLANA_TOKEN_V1_ADDRESS = address(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

export const SOLANA_TOKEN_V2_ADDRESS = address(
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

export const SOLANA_SYSTEM_PROGRAM_ID = address(
    "11111111111111111111111111111111"
);
export const SOLANA_SYSTEM_PROGRAM_NAME = "system";

export const SPLExtensionMetadataSchema = z.object({
    updateAuthority: z.string().nullable(),
    mint: z.string(),
    name: z.string(),
    symbol: z.string(),
    uri: z.string(),
});

export const SPLTokenAccountSchema = z.object({
    data: z.object({
        parsed: z.object({
            info: z.object({
                mintAuthority: z.string().nullable(),
                supply: z.string(),
                freezeAuthority: z.string().nullable(),
                extensions: z.array(z.any()).optional(),
                decimals: z.number().max(100),
            }),
        }),
        program: z.enum(["spl-token", "spl-token-2022"]),
    }),
});

export const SPLTokenTransferInstructionSchema = z.object({
    programId: z.enum([SOLANA_TOKEN_V1_ADDRESS, SOLANA_TOKEN_V2_ADDRESS]),
    program: z.literal("spl-token"),
    parsed: z.object({
        type: z.literal("transferChecked"),
        info: z.object({
            multisigAuthority: z.string(),
            destination: z.string(),
            mint: z.string(),
            tokenAmount: z.object({
                amount: z.string(),
            }),
        }),
    }),
});

export const SolanaTransferInstructionSchema = z.object({
    programId: z.custom((val) => val === SOLANA_SYSTEM_PROGRAM_ID),
    program: z.literal(SOLANA_SYSTEM_PROGRAM_NAME),
    parsed: z.object({
        type: z.literal("transfer"),
        info: z.object({
            source: z.string(),
            destination: z.string(),
            lamports: z.bigint(),
        }),
    }),
});

export const SolanaATASchema = z.object({
    data: z.object({
        parsed: z.object({
            info: z.object({
                isNative: z.boolean(),
                mint: z.string(),
                owner: z.string(),
                state: z.enum(["initialized", "frozen"]),
            }),
        }),
    }),
});

export const MetaplexMetadataSchema = z.object({
    key: z.number(),
    name: z.string(),
    symbol: z.string(),
    uri: z.string(),
});
