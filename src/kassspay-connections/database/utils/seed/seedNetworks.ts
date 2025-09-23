import { KSupportedNetworks } from "@kasssandra/kassspay";
import { db } from "../../index";
import { Network } from "../../schema";

let largest_network_index = 0;

const seed = async (
    name: KSupportedNetworks,
    website: string,
    light_logo_uri: string,
    dark_logo_uri: string
) => {
    await db
        .insert(Network)
        .values({
            id: largest_network_index,
            name,
            website,
            light_logo_uri,
            dark_logo_uri,
        })
        .onConflictDoUpdate({
            target: [Network.id],
            set: {
                name,
                website,
                light_logo_uri,
                dark_logo_uri,
            },
        });

    largest_network_index++;
};

export const seedNetworks = async () => {
    // seeded in order
    await seed(
        "kasssandra",
        "https://kasssandra.com",
        "https://svdtmhcqykgpwuzmlpej.supabase.co/storage/v1/object/public/project-logos/kasssandra/light.png",
        "https://svdtmhcqykgpwuzmlpej.supabase.co/storage/v1/object/public/project-logos/kasssandra/dark.png"
    );
    await seed(
        "kasssandra devnet",
        "https://kasssandra.com",
        "https://svdtmhcqykgpwuzmlpej.supabase.co/storage/v1/object/public/project-logos/kasssandra/light.png",
        "https://svdtmhcqykgpwuzmlpej.supabase.co/storage/v1/object/public/project-logos/kasssandra/dark.png"
    );
    await seed(
        "solana",
        "https://solana.com",
        "https://svdtmhcqykgpwuzmlpej.supabase.co/storage/v1/object/public/project-logos/solana/solana.png",
        "https://svdtmhcqykgpwuzmlpej.supabase.co/storage/v1/object/public/project-logos/solana/solana.png"
    );
    await seed(
        "solana devnet",
        "https://solana.com",
        "https://svdtmhcqykgpwuzmlpej.supabase.co/storage/v1/object/public/project-logos/solana/solana.png",
        "https://svdtmhcqykgpwuzmlpej.supabase.co/storage/v1/object/public/project-logos/solana/solana.png"
    );
};
