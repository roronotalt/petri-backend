import {
    KNetworkToAddressKind,
    KSupportedNetworks,
} from "@kasssandra/kassspay";
import { db } from "../../index";
import {
    Address,
    Token,
    TokenLogo,
    NativeToken,
    VerificationStatus,
} from "../../schema";
import { largest_address_index, incrementLargestAddressIndex } from ".";
import { and, eq } from "drizzle-orm";

let largest_logo_id = 0;
let largest_token_index = 0;

class TokenCreator {
    private token_index;

    constructor() {
        this.token_index = largest_token_index;
        largest_token_index++;
    }

    async seed({
        name,
        description,
        ticker,
        default_precision,
        verification_status,
        light_logo_uri,
        dark_logo_uri,
    }: {
        name: string;
        description: string;
        ticker: string;
        default_precision: number;
        verification_status: (typeof VerificationStatus.enumValues)[number];
        light_logo_uri: string;
        dark_logo_uri?: string;
    }) {
        await db
            .insert(TokenLogo)
            .values({
                id: largest_logo_id,
                uri: light_logo_uri,
            })
            .onConflictDoUpdate({
                target: [TokenLogo.id],
                set: {
                    uri: light_logo_uri,
                },
            });

        const has_dark_logo = dark_logo_uri;

        if (has_dark_logo) {
            largest_logo_id++;
            await db
                .insert(TokenLogo)
                .values({
                    id: largest_logo_id,
                    uri: dark_logo_uri,
                })
                .onConflictDoUpdate({
                    target: [TokenLogo.id],
                    set: {
                        uri: dark_logo_uri,
                    },
                });
        }

        await db
            .insert(Token)
            .values({
                id: this.token_index,
                name,
                description,
                ticker,
                default_precision,
                verification_status,
                light_logo_id: has_dark_logo
                    ? largest_logo_id - 1
                    : largest_logo_id,
                dark_logo_id: largest_logo_id,
                kn_managed: true,
            })
            .onConflictDoUpdate({
                target: [Token.id],
                set: {
                    name,
                    description,
                    ticker,
                    default_precision,
                    verification_status,
                    light_logo_id: has_dark_logo
                        ? largest_logo_id - 1
                        : largest_logo_id,
                    dark_logo_id: largest_logo_id,
                    kn_managed: true,
                },
            });
        largest_logo_id++;
    }

    async addNetwork({
        network_name,
        token_precision,
        public_address,
    }: {
        network_name: KSupportedNetworks;
        public_address: string;
        token_precision: number;
    }) {
        const address_kind = KNetworkToAddressKind(network_name);
        const address_id = await db
            .select({ id: Address.id })
            .from(Address)
            .where(
                and(
                    eq(Address.public_address, public_address),
                    eq(Address.address_kind, address_kind)
                )
            )
            .limit(1);

        if (address_id.length === 0) {
            await db
                .insert(Address)
                .values({
                    id: largest_address_index,
                    public_address,
                    kn_managed: false,
                    address_kind,
                })
                .onConflictDoUpdate({
                    target: [Address.id],
                    set: {
                        public_address,
                        kn_managed: false,
                        address_kind,
                    },
                });
            incrementLargestAddressIndex();
        }

        await db
            .insert(NativeToken)
            .values({
                token_id: this.token_index,
                address_id:
                    address_id[0] === undefined
                        ? largest_address_index - 1
                        : address_id[0].id,
                token_precision,
                network_name,
            })
            .onConflictDoUpdate({
                target: [NativeToken.token_id, NativeToken.network_name],
                set: {
                    token_id: this.token_index,
                    address_id:
                        address_id[0] === undefined
                            ? largest_address_index - 1
                            : address_id[0].id,
                    token_precision,
                    network_name,
                },
            });
    }
}

export const seedTokens = async () => {
    // tokens created in order
    const usdk = new TokenCreator();

    await usdk.seed({
        name: "USDK",
        description: "USDK is a stablecoin representing the US dollar.",
        ticker: "USDK",
        default_precision: 6,
        verification_status: "kasssandra",
        light_logo_uri:
            "https://svdtmhcqykgpwuzmlpej.supabase.co/storage/v1/object/public/token-logos/kasssandra-usdk.png",
    });
    await usdk.addNetwork({
        network_name: "kasssandra",
        token_precision: 6,
        public_address: "usdk",
    });
    await usdk.addNetwork({
        network_name: "kasssandra devnet",
        token_precision: 6,
        public_address: "usdk",
    });

    const solana = new TokenCreator();
    await solana.seed({
        name: "Solana",
        description: "SOL is the native token of the Solana blockchain.",
        ticker: "SOL",
        default_precision: 9,
        verification_status: "verified",
        light_logo_uri:
            "https://svdtmhcqykgpwuzmlpej.supabase.co/storage/v1/object/public/project-logos/solana/solana.png",
    });
    await solana.addNetwork({
        network_name: "solana",
        token_precision: 9,
        public_address: "",
    });
    await solana.addNetwork({
        network_name: "solana devnet",
        token_precision: 9,
        public_address: "",
    });
    await solana.addNetwork({
        network_name: "kasssandra",
        token_precision: 9,
        public_address: "sol",
    });
    await solana.addNetwork({
        network_name: "kasssandra devnet",
        token_precision: 9,
        public_address: "sol",
    });

    const usdc = new TokenCreator();
    await usdc.seed({
        name: "USDC",
        description: "USDC is a stablecoin on the Kasssandra blockchain.",
        ticker: "USDC",
        default_precision: 6,
        verification_status: "verified",
        light_logo_uri:
            "https://svdtmhcqykgpwuzmlpej.supabase.co/storage/v1/object/public/token-logos/usdc.png",
    });
    await usdc.addNetwork({
        network_name: "kasssandra",
        token_precision: 6,
        public_address: "usdc",
    });
    await usdc.addNetwork({
        network_name: "kasssandra devnet",
        token_precision: 6,
        public_address: "usdc",
    });
    await usdc.addNetwork({
        network_name: "solana",
        token_precision: 6,
        public_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });
    await usdc.addNetwork({
        network_name: "solana devnet",
        token_precision: 6,
        public_address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    });
};
