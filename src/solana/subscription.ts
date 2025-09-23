import type { WebSocketHandler } from "../stores";
import {
    Address,
    AddressBalance,
    Token,
    TokenLogo,
    NativeToken,
    Transaction,
    TransactionPart,
} from "../kassspay-connections/database/schema";
import { and, desc, eq, or, sql, type InferSelectModel } from "drizzle-orm";
import {
    KformatUnits,
    KNetworkToAddressKind,
    Kparse,
    KparseUnits,
    Kstringify,
    KSupportedSolanaExtensions,
    type KSupportedNetworks,
} from "@kasssandra/kassspay";
import { solanaDevnetRPC, solanaRPC } from "../kassspay-connections/solana";
import { election } from "../elections";
import {
    address as SolanaAddress,
    decodeAccount,
    getAddressEncoder,
    getProgramDerivedAddress,
    getPublicKeyFromAddress,
    type Address as SolanaAddressType,
    type Signature,
    getBase64Codec,
} from "@solana/kit";
import { pubsubWebsocketSubscribe, SubscriptionType } from "../stores";
import { db } from "../kassspay-connections/database";
import { alias } from "drizzle-orm/pg-core";
import * as Sentry from "@sentry/node";
import { generateTxHash } from "../kassspay-connections/database/utils/tx/generateTxhash";
import { z } from "zod";
import { getsertExternalAddress } from "../kassspay-connections/database/utils/tx/getsertExternalAddress";
import type {
    KSolanaNativeTokenExtentions,
    KSolanaNativeTokenMetadata,
    KTokenMetadata,
    KWalletUpdatesResponse,
} from "@kasssandra/kassspay";
import { solanaLookup } from "./solanaLookup";
import {
    fetchAllSolanaV1TokenAccounts,
    fetchAllSolanaV2TokenAccounts,
} from "./tokenAccounts";
import {
    SOLANA_SYSTEM_PROGRAM_ID,
    SOLANA_TOKEN_V1_ADDRESS,
    SOLANA_TOKEN_V2_ADDRESS,
    SolanaATASchema,
    SolanaTransferInstructionSchema,
    SPLExtensionMetadataSchema,
    SPLTokenAccountSchema,
    SPLTokenTransferInstructionSchema,
} from "./stores";
import { fetchTokenMetadata } from "./tokenMetadata";
import { getsertSolanaToken } from "./getsertSolanaToken";
import { pubClient } from "../kassspay-connections/pubsub";

export const solanaSubscription = async (
    ws: WebSocketHandler,
    client_subscription_id: string,
    monitoring_address: Pick<
        InferSelectModel<typeof Address>,
        "id" | "public_address" | "address_kind" | "kn_managed"
    >,
    network: Extract<KSupportedNetworks, "solana" | "solana devnet">
) => {
    const server_subscription_id = `solana_subscription_${monitoring_address.id}`;
    let rpc: typeof solanaRPC;
    switch (network) {
        case "solana":
            rpc = solanaRPC;
            break;
        case "solana devnet":
            rpc = solanaDevnetRPC;
            break;
    }

    const main_address = SolanaAddress(monitoring_address.public_address);

    ws.data.subscriptions.set(`server_subscription_id`, {
        type: SubscriptionType.ELECTION,
    });

    ws.data.subscriptions.set(
        `client_id_${client_subscription_id}_${server_subscription_id}`,
        {
            type: SubscriptionType.INTERVAL,
            interval: setInterval(async () => {
                if (ws.data.window_open) {
                    const [v1_accounts, v2_accounts, [solana_token]] =
                        await Promise.all([
                            fetchAllSolanaV1TokenAccounts(
                                rpc,
                                monitoring_address.public_address,
                                "finalized"
                            ),
                            fetchAllSolanaV2TokenAccounts(
                                rpc,
                                monitoring_address.public_address,
                                "finalized"
                            ),
                            solanaLookup(network),
                        ]);

                    const addresses: SolanaAddressType[] = [
                        main_address,
                        ...v1_accounts.value.map((v) => v.pubkey),
                        ...v2_accounts.value.map((v) => v.pubkey),
                    ];

                    const signatures = await Promise.all(
                        addresses.map((address) =>
                            rpc
                                .getSignaturesForAddress(address, {
                                    limit: 10,
                                    commitment: "finalized",
                                })
                                .send()
                        )
                    );

                    if (solana_token == undefined) {
                        Sentry.captureException(
                            `Multiple/no solana token networks found for address ${monitoring_address.id}`,
                            {
                                level: "fatal",
                                extra: {
                                    solana_token,
                                    address: monitoring_address,
                                    network,
                                },
                            }
                        );
                        return;
                    }

                    for (const [
                        address_index,
                        owned_address,
                    ] of addresses.entries()) {
                        let before: Signature;
                        let address_signatures = signatures[address_index]!;

                        signature_pagination_loop: while (
                            address_signatures.length > 0
                        ) {
                            for (const [
                                signature_index,
                                signature,
                            ] of address_signatures.entries()) {
                                // skip any errored signatures
                                if (signature.err != null) {
                                    // signature pagination if last(oldest) tx was errored
                                    if (
                                        signature_index ===
                                        address_signatures.length - 1
                                    ) {
                                        before =
                                            address_signatures.at(
                                                -1
                                            )!.signature;
                                        address_signatures = await rpc
                                            .getSignaturesForAddress(
                                                owned_address,
                                                {
                                                    limit: 10,
                                                    commitment: "finalized",
                                                    before: before,
                                                }
                                            )
                                            .send();
                                    } else {
                                        continue;
                                    }
                                }

                                // fetch the transaction in the database if one exists and the onchain transaction
                                const [existing_transaction, signature_tx] =
                                    await Promise.all([
                                        db
                                            .select()
                                            .from(Transaction)
                                            .where(
                                                and(
                                                    eq(
                                                        Transaction.hash,
                                                        signature.signature
                                                    ),
                                                    eq(
                                                        Transaction.simulated,
                                                        false
                                                    ),
                                                    eq(
                                                        Transaction.network,
                                                        network
                                                    )
                                                )
                                            ),
                                        rpc
                                            .getTransaction(
                                                signature.signature,
                                                {
                                                    commitment: "finalized",
                                                    encoding: "jsonParsed",
                                                }
                                            )
                                            .send(),
                                    ]);

                                if (signature_tx == null) {
                                    Sentry.captureException(
                                        `No onchain transaction found for signature ${signature} for address ${monitoring_address.id}`,
                                        {
                                            level: "fatal",
                                            extra: {
                                                address: monitoring_address,
                                                network,
                                                signature,
                                            },
                                        }
                                    );
                                    return;
                                }

                                // tx does not exist in the database, create it
                                if (existing_transaction.length === 0) {
                                    // after doing the transaction, send the balance update to the clients
                                    const balance_update: KWalletUpdatesResponse =
                                        {
                                            id: client_subscription_id,
                                            event: "balance_update",
                                            data: {
                                                balance_change: new Map<
                                                    number,
                                                    bigint
                                                >(),
                                            },
                                        };

                                    await db.transaction(async (tx) => {
                                        await tx.insert(Transaction).values({
                                            hash: signature.signature,
                                            network: network,
                                            initiator_type: "server",
                                            tx_type: "network_tx",
                                            simulated: false,
                                        });

                                        // check for SOL transfers
                                        for (const instruction of signature_tx.transaction.message.instructions.filter(
                                            (instruction) =>
                                                instruction.programId ===
                                                    SOLANA_TOKEN_V1_ADDRESS ||
                                                instruction.programId ===
                                                    SOLANA_TOKEN_V2_ADDRESS ||
                                                instruction.programId ===
                                                    SOLANA_SYSTEM_PROGRAM_ID
                                        )) {
                                            const spl_instruction_parsed =
                                                SPLTokenTransferInstructionSchema.safeParse(
                                                    instruction
                                                );

                                            const sol_instruction_parsed =
                                                SolanaTransferInstructionSchema.safeParse(
                                                    instruction
                                                );

                                            if (
                                                sol_instruction_parsed.success
                                            ) {
                                                for (const instruction of signature_tx.transaction.message.instructions.filter(
                                                    (instruction) =>
                                                        instruction.programId ===
                                                        SOLANA_SYSTEM_PROGRAM_ID
                                                )) {
                                                    if (
                                                        !sol_instruction_parsed.success
                                                    ) {
                                                        Sentry.captureException(
                                                            "Solana transfer instruction parsed failed",
                                                            {
                                                                level: "error",
                                                                extra: {
                                                                    sol_instruction_parsed,
                                                                    instruction,
                                                                    signature_tx,
                                                                },
                                                            }
                                                        );
                                                        continue;
                                                    }

                                                    const {
                                                        source,
                                                        lamports,
                                                        destination,
                                                    } =
                                                        sol_instruction_parsed
                                                            .data.parsed.info;

                                                    // create the source and destination addresses on our database
                                                    const [
                                                        source_address,
                                                        destination_address,
                                                    ] = await Promise.all([
                                                        getsertExternalAddress(
                                                            source,
                                                            KNetworkToAddressKind(
                                                                network
                                                            )
                                                        ),
                                                        destination ==
                                                        monitoring_address.public_address
                                                            ? {
                                                                  id: monitoring_address.id,
                                                              }
                                                            : getsertExternalAddress(
                                                                  destination,
                                                                  KNetworkToAddressKind(
                                                                      network
                                                                  )
                                                              ),
                                                    ]);

                                                    if (
                                                        source_address.kn_managed
                                                    ) {
                                                        Sentry.captureException(
                                                            "KN generated address may have been compromised, source is kn managed",
                                                            {
                                                                level: "fatal",
                                                                extra: {
                                                                    source,
                                                                    source_address,
                                                                    network,
                                                                    signature,
                                                                },
                                                            }
                                                        );
                                                        throw tx.rollback();
                                                    }

                                                    const transferred_lamports =
                                                        KparseUnits(
                                                            KformatUnits(
                                                                lamports,
                                                                solana_token.native_token_precision
                                                            ),
                                                            solana_token.default_precision
                                                        );

                                                    await Promise.all([
                                                        tx
                                                            .insert(
                                                                TransactionPart
                                                            )
                                                            .values({
                                                                transaction_hash:
                                                                    signature.signature,
                                                                fee_payed: "0",
                                                                fee_paying_address_id:
                                                                    source_address.id,
                                                                from_address_id:
                                                                    source_address.id,
                                                                to_address_id:
                                                                    destination_address.id,
                                                                from_native_token_id:
                                                                    solana_token.native_token_id,
                                                                to_native_token_id:
                                                                    solana_token.native_token_id,
                                                                amount: transferred_lamports.toString(),
                                                                status: "completed",
                                                            }),
                                                        tx
                                                            .insert(
                                                                AddressBalance
                                                            )
                                                            .values({
                                                                address_id:
                                                                    destination_address.id,
                                                                native_token_id:
                                                                    solana_token.native_token_id,
                                                                balance:
                                                                    transferred_lamports.toString(),
                                                            })
                                                            .onConflictDoUpdate(
                                                                {
                                                                    target: [
                                                                        AddressBalance.address_id,
                                                                        AddressBalance.native_token_id,
                                                                    ],
                                                                    set: {
                                                                        balance: sql`${
                                                                            AddressBalance.balance
                                                                        } + ${sql.raw(
                                                                            `excluded.${AddressBalance.balance.name}`
                                                                        )}`,
                                                                    },
                                                                }
                                                            ),
                                                    ]);

                                                    // accrue the balance changes to the monitoring address
                                                    if (
                                                        destination_address.id ===
                                                        monitoring_address.id
                                                    ) {
                                                        balance_update.data.balance_change.set(
                                                            solana_token.token_id,
                                                            transferred_lamports +
                                                                (balance_update.data.balance_change.get(
                                                                    solana_token.token_id
                                                                ) ?? 0n)
                                                        );
                                                    } else if (
                                                        source_address.id ===
                                                        monitoring_address.id
                                                    ) {
                                                        balance_update.data.balance_change.set(
                                                            solana_token.token_id,
                                                            -transferred_lamports +
                                                                (balance_update.data.balance_change.get(
                                                                    solana_token.token_id
                                                                ) ?? 0n)
                                                        );
                                                    }
                                                }
                                            }
                                            // check for SPL token and SPL-token-2022 transactions
                                            else if (
                                                spl_instruction_parsed.success
                                            ) {
                                                if (
                                                    monitoring_address.kn_managed &&
                                                    SolanaAddress(
                                                        spl_instruction_parsed
                                                            .data.parsed.info
                                                            .multisigAuthority
                                                    ) === owned_address
                                                ) {
                                                    Sentry.captureException(
                                                        "KN generated address may have been compromised, multisigAuthority is the owned address",
                                                        {
                                                            level: "fatal",
                                                            extra: {
                                                                address:
                                                                    monitoring_address,
                                                                owned_address,
                                                                instruction,
                                                                network,
                                                                signature,
                                                            },
                                                        }
                                                    );
                                                    throw tx.rollback();
                                                }

                                                const token =
                                                    await getsertSolanaToken({
                                                        network: network,
                                                        instruction_parsed:
                                                            spl_instruction_parsed.data,
                                                        rpc: rpc,
                                                    });

                                                if (token == null) {
                                                    continue;
                                                }

                                                const destination_ata_lookup =
                                                    await rpc
                                                        .getAccountInfo(
                                                            SolanaAddress(
                                                                spl_instruction_parsed
                                                                    .data.parsed
                                                                    .info
                                                                    .destination
                                                            ),
                                                            {
                                                                commitment:
                                                                    "finalized",
                                                                encoding:
                                                                    "jsonParsed",
                                                            }
                                                        )
                                                        .send();

                                                const destination_ata_parsed =
                                                    SolanaATASchema.safeParse(
                                                        destination_ata_lookup.value
                                                    );

                                                if (
                                                    !destination_ata_parsed.success
                                                ) {
                                                    console.error(
                                                        "destination ata parse failed",
                                                        destination_ata_parsed,
                                                        destination_ata_lookup,
                                                        instruction
                                                    );
                                                    continue;
                                                }

                                                if (
                                                    destination_ata_parsed.data
                                                        .data.parsed.info
                                                        .mint !==
                                                    spl_instruction_parsed.data
                                                        .parsed.info.mint
                                                ) {
                                                    Sentry.captureException(
                                                        "destination ata mint does not match instruction mint",
                                                        {
                                                            level: "error",
                                                            extra: {
                                                                destination_ata_parsed,
                                                                spl_instruction_parsed,
                                                                signature,
                                                            },
                                                        }
                                                    );
                                                    continue;
                                                }

                                                // check if the destination is a kn managed address
                                                const [
                                                    source_address,
                                                    destination_address,
                                                ] = await Promise.all([
                                                    getsertExternalAddress(
                                                        spl_instruction_parsed
                                                            .data.parsed.info
                                                            .multisigAuthority,
                                                        KNetworkToAddressKind(
                                                            network
                                                        )
                                                    ),
                                                    destination_ata_parsed.data
                                                        .data.parsed.info
                                                        .owner ==
                                                    monitoring_address.public_address
                                                        ? {
                                                              id: monitoring_address.id,
                                                              kn_managed:
                                                                  monitoring_address.kn_managed,
                                                          }
                                                        : getsertExternalAddress(
                                                              spl_instruction_parsed
                                                                  .data.parsed
                                                                  .info
                                                                  .destination,
                                                              KNetworkToAddressKind(
                                                                  network
                                                              )
                                                          ),
                                                ]);

                                                if (
                                                    destination_ata_parsed.data
                                                        .data.parsed.info
                                                        .state === "frozen" &&
                                                    destination_address.kn_managed &&
                                                    token.kn_managed
                                                ) {
                                                    Sentry.captureException(
                                                        "kassspay wallet address ata has been frozen",
                                                        {
                                                            level: "fatal",
                                                            extra: {
                                                                spl_instruction_parsed,
                                                                destination_address,
                                                                signature,
                                                            },
                                                        }
                                                    );
                                                    continue;
                                                }

                                                if (source_address.kn_managed) {
                                                    Sentry.captureException(
                                                        "KN generated address may have been compromised, fund source is kn managed",
                                                        {
                                                            level: "fatal",
                                                            extra: {
                                                                address:
                                                                    source_address,
                                                                network,
                                                                signature,
                                                                instruction,
                                                            },
                                                        }
                                                    );
                                                    throw tx.rollback();
                                                }

                                                const transferred_token =
                                                    KparseUnits(
                                                        KformatUnits(
                                                            BigInt(
                                                                spl_instruction_parsed
                                                                    .data.parsed
                                                                    .info
                                                                    .tokenAmount
                                                                    .amount
                                                            ),
                                                            solana_token.native_token_precision
                                                        ),
                                                        solana_token.default_precision
                                                    );

                                                await Promise.all([
                                                    tx
                                                        .insert(TransactionPart)
                                                        .values({
                                                            transaction_hash:
                                                                signature.signature,
                                                            fee_payed: "0",
                                                            fee_paying_address_id:
                                                                source_address.id,
                                                            from_address_id:
                                                                source_address.id,
                                                            to_address_id:
                                                                destination_address.id,
                                                            from_native_token_id:
                                                                token.native_token_id,
                                                            to_native_token_id:
                                                                token.native_token_id,
                                                            amount: transferred_token.toString(),
                                                            status: "completed",
                                                        }),
                                                    tx
                                                        .insert(AddressBalance)
                                                        .values({
                                                            address_id:
                                                                destination_address.id,
                                                            native_token_id:
                                                                token.native_token_id,
                                                            balance:
                                                                transferred_token.toString(),
                                                        })
                                                        .onConflictDoUpdate({
                                                            target: [
                                                                AddressBalance.address_id,
                                                                AddressBalance.native_token_id,
                                                            ],
                                                            set: {
                                                                balance: sql`${
                                                                    AddressBalance.balance
                                                                } + ${sql.raw(
                                                                    `excluded.${AddressBalance.balance.name}`
                                                                )}`,
                                                            },
                                                        }),
                                                ]);

                                                // accrue the balance changes to the monitoring address
                                                if (
                                                    destination_address.id ===
                                                    monitoring_address.id
                                                ) {
                                                    balance_update.data.balance_change.set(
                                                        token.token_id,
                                                        transferred_token +
                                                            (balance_update.data.balance_change.get(
                                                                token.token_id
                                                            ) ?? 0n)
                                                    );
                                                } else if (
                                                    source_address.id ===
                                                    monitoring_address.id
                                                ) {
                                                    balance_update.data.balance_change.set(
                                                        token.token_id,
                                                        -transferred_token +
                                                            (balance_update.data.balance_change.get(
                                                                token.token_id
                                                            ) ?? 0n)
                                                    );
                                                }
                                            }
                                        }
                                    });

                                    ws.send(Kstringify(balance_update));
                                    await pubClient.publish(
                                        server_subscription_id,
                                        Kstringify(balance_update)
                                    );
                                } else if (
                                    existing_transaction[0] != undefined &&
                                    existing_transaction.length === 1
                                ) {
                                    // tx found on our db
                                    // TODO: ensure that the transaction is identical to the one in the database
                                    // much more likley that somebody on solana notices hash collision but safety first
                                    break signature_pagination_loop;
                                } else {
                                    // signature hash collision
                                    Sentry.captureException(
                                        "Signature hash collision",
                                        {
                                            level: "fatal",
                                            extra: {
                                                signature,
                                                existing_transaction,
                                                signature_tx,
                                            },
                                        }
                                    );
                                    break signature_pagination_loop;
                                }
                            }

                            // get the last signature for the address, (also oldest since array is chronologically ordered)
                            before = address_signatures.at(-1)!.signature;
                            // get the previous 10 signatures for the address
                            address_signatures = await rpc
                                .getSignaturesForAddress(owned_address, {
                                    limit: 10,
                                    commitment: "finalized",
                                    before: before,
                                })
                                .send();
                        }
                    }
                }
            }, 10000),
        }
    );
};
