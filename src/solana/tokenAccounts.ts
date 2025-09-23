import { SOLANA_TOKEN_V1_ADDRESS, SOLANA_TOKEN_V2_ADDRESS } from "./stores";
import { solanaRPC } from "../kassspay-connections/solana";
import { address as SolanaAddress, type Commitment } from "@solana/kit";

export const fetchAllSolanaV1TokenAccounts = async (
    rpc: typeof solanaRPC,
    address: string,
    commitment: Commitment
) => {
    return await rpc
        .getTokenAccountsByOwner(
            SolanaAddress(address),
            {
                programId: SOLANA_TOKEN_V1_ADDRESS,
            },
            {
                commitment: commitment,
                encoding: "jsonParsed",
            }
        )
        .send();
};

export const fetchAllSolanaV2TokenAccounts = async (
    rpc: typeof solanaRPC,
    address: string,
    commitment: Commitment
) => {
    return await rpc
        .getTokenAccountsByOwner(
            SolanaAddress(address),
            {
                programId: SOLANA_TOKEN_V2_ADDRESS,
            },
            {
                commitment: commitment,
                encoding: "jsonParsed",
            }
        )
        .send();
};
