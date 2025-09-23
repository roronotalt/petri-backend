import { relations, sql } from "drizzle-orm";
import {
    pgTable,
    serial,
    text,
    integer,
    timestamp,
    boolean,
    pgEnum,
    customType,
    bigint,
    primaryKey,
    unique,
    numeric,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import * as devalue from "devalue";
import {
    KAddressKinds,
    KSupportedNetworks,
    KVerificationStatuses,
} from "@kasssandra/kassspay";
import type { KNativeTokenMetadata } from "@kasssandra/kassspay";

export const customJsonb = <TData>(name: string) =>
    customType<{ data: TData; driverData: string }>({
        dataType() {
            return "jsonb";
        },
        toDriver(value: TData): string {
            return devalue.stringify(value);
        },
    })(name);

export const User = pgTable("user", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    username: text("username").unique(),
    preferred_name: text("preferred_name").notNull(),
    accepted_tos: boolean("accepted_tos").notNull().default(false),
    created_at: timestamp("created_at").notNull().defaultNow(),
});

export const UserRelations = relations(User, ({ many }) => ({
    wallets: many(UserWallet),
    project_wallets: many(UserProjectWallet),
    projects: many(Project),
    emails: many(UserEmail),
    sessions: many(UserSession),
}));

export const UserEmail = pgTable("user_email", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    user_id: bigint("user_id", { mode: "number" })
        .references(() => User.id, { onDelete: "cascade" })
        .notNull(),
    email: text("email").unique(),
    primary: boolean("primary").notNull().default(false),
    verified: boolean("verified").notNull().default(false),
    created_at: timestamp("created_at").notNull().defaultNow(),
});

export const UserEmailRelations = relations(UserEmail, ({ one }) => ({
    user: one(User, {
        fields: [UserEmail.user_id],
        references: [User.id],
    }),
}));

export const EmailToken = pgTable("email_token", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    email: text("email").notNull(),
    token: text("token").notNull().unique(),
    code: text("code").notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
});

export const UserSession = pgTable("user_session", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    user_id: bigint("user_id", { mode: "number" })
        .references(() => User.id, { onDelete: "cascade" })
        .notNull(),
    session_token: text("session_token").notNull().unique(),
    session_key: text("session_key").notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    expires_at: timestamp("expires_at").notNull(),
});

export const UserSessionRelations = relations(UserSession, ({ one }) => ({
    user: one(User, {
        fields: [UserSession.user_id],
        references: [User.id],
    }),
}));

export const UserWallet = pgTable("user_wallet", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    name: text("name").notNull(),
    user_id: bigint("user_id", { mode: "number" })
        .references(() => User.id, { onDelete: "cascade" })
        .notNull(),
});

export const UserWalletRelations = relations(UserWallet, ({ one, many }) => ({
    user: one(User, {
        fields: [UserWallet.user_id],
        references: [User.id],
    }),
    addresses: many(UserWalletAddress),
}));

export const UserWalletAddress = pgTable("user_wallet_address", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    user_wallet_id: bigint("user_wallet_id", { mode: "number" })
        .references(() => UserWallet.id)
        .notNull(),
    address_id: bigint("address_id", { mode: "number" })
        .references(() => Address.id)
        .notNull(),
});

export const UserWalletAddressRelations = relations(
    UserWalletAddress,
    ({ one }) => ({
        user_wallet: one(UserWallet, {
            fields: [UserWalletAddress.user_wallet_id],
            references: [UserWallet.id],
        }),
        address: one(Address, {
            fields: [UserWalletAddress.address_id],
            references: [Address.id],
        }),
    })
);

export const VerificationStatus = pgEnum(
    "verification_status",
    KVerificationStatuses
);

export const Organization = pgTable("organization", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    user_id: bigint("user_id", { mode: "number" })
        .references(() => User.id, { onDelete: "set null" })
        .notNull(),
    name: text("name").notNull().unique(),
    verification_status: VerificationStatus("verification_status")
        .notNull()
        .default("unverified"),
    created_at: timestamp("created_at").notNull().defaultNow(),
});

export const OrganizationRelations = relations(Organization, ({ one }) => ({
    user: one(User, {
        fields: [Organization.user_id],
        references: [User.id],
    }),
}));

export const Project = pgTable("project", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    organization_id: bigint("organization_id", { mode: "number" })
        .references(() => Organization.id)
        .notNull(),
    name: text("name").notNull(),
    production_mode: boolean("production_mode").notNull().default(false),
    light_logo_id: bigint("light_logo_id", { mode: "number" }).references(
        () => ProjectLogo.id
    ),
    dark_logo_id: bigint("dark_logo_id", { mode: "number" }).references(
        () => ProjectLogo.id
    ),
    verification_status: VerificationStatus("verification_status")
        .notNull()
        .default("unverified"),
    client_api_key: text("client_api_key").notNull().unique(),
    secret_api_key: text("secret_api_key").notNull().unique(),
    created_at: timestamp("created_at").notNull().defaultNow(),
});

export const ProjectRelations = relations(Project, ({ one, many }) => ({
    organization: one(Organization, {
        fields: [Project.organization_id],
        references: [Organization.id],
    }),
    light_logo: one(ProjectLogo, {
        fields: [Project.light_logo_id],
        references: [ProjectLogo.id],
    }),
    dark_logo: one(ProjectLogo, {
        fields: [Project.dark_logo_id],
        references: [ProjectLogo.id],
    }),
    wallets: many(ProjectWallet),
}));

export const ProjectLogo = pgTable("project_logo", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    path: text("path").notNull().unique(),
    uri: text("uri").notNull(),
    uploaded_at: timestamp("uploaded_at").notNull().defaultNow(),
});

export const ProjectWallet = pgTable("project_wallet", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    user_id: bigint("user_id", { mode: "number" }).references(() => User.id, {
        onDelete: "set null",
    }),
    project_id: bigint("project_id", { mode: "number" })
        .references(() => Project.id)
        .notNull(),
    primary: boolean("primary").notNull().default(false),
    created_at: timestamp("created_at").notNull().defaultNow(),
});

export const ProjectWalletRelations = relations(
    ProjectWallet,
    ({ one, many }) => ({
        project: one(Project, {
            fields: [ProjectWallet.project_id],
            references: [Project.id],
        }),
        addresses: many(ProjectWalletAddress),
    })
);

export const ProjectWalletAddress = pgTable("project_wallet_address", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    project_wallet_id: bigint("project_wallet_id", {
        mode: "number",
    })
        .references(() => ProjectWallet.id)
        .notNull(),
    address_id: bigint("address_id", { mode: "number" })
        .references(() => Address.id)
        .notNull(),
});

export const ProjectWalletAddressRelations = relations(
    ProjectWalletAddress,
    ({ one }) => ({
        project_wallet: one(ProjectWallet, {
            fields: [ProjectWalletAddress.project_wallet_id],
            references: [ProjectWallet.id],
        }),
        address: one(Address, {
            fields: [ProjectWalletAddress.address_id],
            references: [Address.id],
        }),
    })
);

export const UserProjectWallet = pgTable("user_project_wallet", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    user_id: bigint("user_id", { mode: "number" })
        .references(() => User.id, { onDelete: "set null" })
        .notNull(),
    project_id: bigint("project_id", { mode: "number" })
        .references(() => Project.id)
        .notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
});

export const UserProjectWalletRelations = relations(
    UserProjectWallet,
    ({ one, many }) => ({
        user: one(User, {
            fields: [UserProjectWallet.user_id],
            references: [User.id],
        }),
        project: one(Project, {
            fields: [UserProjectWallet.project_id],
            references: [Project.id],
        }),
        addresses: many(UserProjectWalletAddress),
    })
);

export const UserProjectWalletAddress = pgTable("user_project_wallet_address", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    address_id: bigint("address_id", { mode: "number" })
        .references(() => Address.id)
        .notNull(),
    user_project_wallet_id: bigint("user_project_wallet_id", {
        mode: "number",
    }).references(() => UserProjectWallet.id),
});

export const UserProjectWalletAddressRelations = relations(
    UserProjectWalletAddress,
    ({ one }) => ({
        user_project_wallet: one(UserProjectWallet, {
            fields: [UserProjectWalletAddress.user_project_wallet_id],
            references: [UserProjectWallet.id],
        }),
        address: one(Address, {
            fields: [UserProjectWalletAddress.address_id],
            references: [Address.id],
        }),
    })
);

export const Networks = pgEnum("networks", KSupportedNetworks);
export const AddressKind = pgEnum("address_kind", KAddressKinds);

export const Network = pgTable("network", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    name: Networks("name").notNull().unique(),
    website: text("website").notNull(),
    light_logo_uri: text("light_logo_uri").notNull(),
    dark_logo_uri: text("dark_logo_uri").notNull(),
});

export const Address = pgTable(
    "address",
    {
        id: bigint("id", { mode: "number" })
            .primaryKey()
            .generatedByDefaultAsIdentity(),
        public_address: text("public_address").notNull(),
        private_key: text("private_key"),
        kn_managed: boolean("kn_managed").notNull().default(false),
        user_managed_at: timestamp("user_managed_at"),
        address_kind: AddressKind("address_kind").notNull(),
    },
    (table) => [
        unique("address_unique_index").on(
            table.public_address,
            table.address_kind
        ),
    ]
);

export const AddressRelations = relations(Address, ({ one, many }) => ({
    user_wallets: many(UserWalletAddress),
    user_project_wallets: many(UserProjectWalletAddress),
    project_wallets: many(ProjectWallet),
    balances: many(AddressBalance, { relationName: "address" }),
    native_tokens: many(NativeToken),
}));

export const Token = pgTable(
    "token",
    {
        id: bigint("id", { mode: "number" })
            .primaryKey()
            .generatedByDefaultAsIdentity(),
        verification_status: VerificationStatus("verification_status")
            .notNull()
            .default("unverified"),
        kn_managed: boolean("kn_managed").notNull().default(false),
        name: text("name").notNull(),
        description: text("description"),
        ticker: text("ticker").notNull(),
        default_precision: integer("default_precision").notNull(),
        light_logo_id: bigint("light_logo_id", { mode: "number" }).references(
            () => TokenLogo.id
        ),
        dark_logo_id: bigint("dark_logo_id", { mode: "number" }).references(
            () => TokenLogo.id
        ),
        created_at: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => [
        // verified and higher tokens may NOT have the same ticker
        uniqueIndex("verified_token_ticker_unique_index")
            .on(table.verification_status, sql`UPPER(${table.ticker})`)
            .where(
                sql`${table.verification_status} in ('verified','kasssandra')`
            ),
    ]
);

export const TokenRelations = relations(Token, ({ one, many }) => ({
    dark_logo: one(TokenLogo, {
        fields: [Token.dark_logo_id],
        references: [TokenLogo.id],
    }),
    light_logo: one(TokenLogo, {
        fields: [Token.light_logo_id],
        references: [TokenLogo.id],
    }),
    native_tokens: many(NativeToken),
}));

export const TokenLogo = pgTable("token_logo", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    uri: text("uri").notNull(),
    uploaded_at: timestamp("uploaded_at").notNull().defaultNow(),
});

export const NativeToken = pgTable(
    "native_token",
    {
        id: bigint("id", { mode: "number" })
            .primaryKey()
            .generatedByDefaultAsIdentity(),
        token_precision: integer("token_precision").notNull(),
        token_id: bigint("token_id", { mode: "number" })
            .references(() => Token.id, { onDelete: "cascade" })
            .notNull(),
        address_id: bigint("address_id", { mode: "number" })
            .references(() => Address.id)
            .notNull(),
        network_name: Networks("network_name")
            .references(() => Network.name)
            .notNull(),
        metadata: customJsonb<KNativeTokenMetadata>("metadata"),
    },
    (table) => [
        unique("token_network_unique_index").on(
            table.token_id,
            table.network_name
        ),
    ]
);

export const NativeTokenRelations = relations(NativeToken, ({ one }) => ({
    token: one(Token, {
        fields: [NativeToken.token_id],
        references: [Token.id],
    }),
    address: one(Address, {
        fields: [NativeToken.address_id],
        references: [Address.id],
    }),
    network: one(Network, {
        fields: [NativeToken.network_name],
        references: [Network.name],
    }),
}));

export const TransactionStatus = pgEnum("transaction_status", [
    "pending",
    "processing",
    "completed",
    "failed",
    "rolled_back",
]);

export const AddressBalance = pgTable(
    "address_balance",
    {
        address_id: bigint("address_id", { mode: "number" })
            .references(() => Address.id)
            .notNull(),
        native_token_id: bigint("native_token_id", {
            mode: "number",
        })
            .references(() => NativeToken.id, {
                onDelete: "cascade",
            })
            .notNull(),
        balance: numeric("balance", {
            precision: 160,
            scale: 0,
            mode: "string",
        })
            .$type<string>()
            .notNull(),
    },
    (table) => [
        primaryKey({
            columns: [table.address_id, table.native_token_id],
        }),
    ]
);

export const AddressBalanceRelations = relations(AddressBalance, ({ one }) => ({
    address: one(Address, {
        fields: [AddressBalance.address_id],
        references: [Address.id],
        relationName: "address",
    }),
    native_token: one(NativeToken, {
        fields: [AddressBalance.native_token_id],
        references: [NativeToken.id],
    }),
}));

export const WalletType = pgEnum("wallet_type", [
    "developer",
    "project",
    "user",
]);

export const InitiatorType = pgEnum("initiator_type", [
    ...WalletType.enumValues,
    "server",
]);

export const TxType = pgEnum("tx_type", [
    "network_tx",
    "bridge_in",
    "bridge_out",
]);

export const Transaction = pgTable(
    "transaction",
    {
        hash: text("hash").primaryKey().notNull(),
        network: Networks("network").notNull(),
        initiator_type: InitiatorType("initiator_type").notNull(),
        tx_type: TxType("tx_type").notNull(),
        simulated: boolean("simulated").notNull().default(false),
        created_at: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => [
        unique("transaction_unique_index").on(table.hash, table.network),
    ]
);

export const TransactionRelations = relations(Transaction, ({ one }) => ({
    network: one(Network, {
        fields: [Transaction.network],
        references: [Network.name],
    }),
}));

export const Simulated_Transaction = pgTable("simulated_transaction", {
    transaction_hash: text("transaction_hash")
        .references(() => Transaction.hash)
        .primaryKey()
        .notNull(),
    receiving_address: text("receiving_address").notNull(),
    sending_amount: numeric("sending_amount", {
        precision: 160,
        scale: 0,
        mode: "string",
    }).notNull(),
    wallet_type: WalletType("wallet_type").notNull(),
    wallet_id: bigint("wallet_id", { mode: "number" }).notNull(),
    token_id: bigint("token_id", { mode: "number" }).notNull(),
    receiving_network: Networks("receiving_network").notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
});

export const TransactionPart = pgTable("transaction_part", {
    id: bigint("id", { mode: "number" })
        .primaryKey()
        .generatedByDefaultAsIdentity(),
    transaction_hash: text("transaction_hash")
        .references(() => Transaction.hash, { onDelete: "cascade" })
        .notNull(),
    fee_paying_address_id: bigint("fee_paying_address_id", {
        mode: "number",
    })
        .references(() => Address.id)
        .notNull(),
    fee_payed: numeric("fee_payed", {
        precision: 160,
        scale: 0,
        mode: "string",
    }).notNull(),
    from_address_id: bigint("from_address_id", { mode: "number" })
        .references(() => Address.id)
        .notNull(),
    to_address_id: bigint("to_address_id", { mode: "number" })
        .references(() => Address.id)
        .notNull(),
    from_native_token_id: bigint("from_native_token_id", {
        mode: "number",
    })
        .references(() => NativeToken.id)
        .notNull(),
    to_native_token_id: bigint("to_native_token_id", { mode: "number" })
        .references(() => NativeToken.id)
        .notNull(),
    amount: numeric("amount", {
        precision: 160,
        scale: 0,
        mode: "string",
    }).notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    status: TransactionStatus("status").notNull().default("pending"),
});

export const TransactionPartRelations = relations(
    TransactionPart,
    ({ one }) => ({
        from_address: one(Address, {
            fields: [TransactionPart.from_address_id],
            references: [Address.id],
        }),
        fee_paying_address: one(Address, {
            fields: [TransactionPart.fee_paying_address_id],
            references: [Address.id],
        }),
        to_address: one(Address, {
            fields: [TransactionPart.to_address_id],
            references: [Address.id],
        }),
        from_native_token: one(NativeToken, {
            fields: [TransactionPart.from_native_token_id],
            references: [NativeToken.id],
        }),
        to_native_token: one(NativeToken, {
            fields: [TransactionPart.to_native_token_id],
            references: [NativeToken.id],
        }),
    })
);
