import { db } from "../../index";
import {
    UserWalletAddress,
    UserProjectWalletAddress,
    ProjectWalletAddress,
    WalletType,
} from "../../schema";
import { eq, and } from "drizzle-orm";

export const getWalletKNAddresses = async ({
    wallet_type,
    wallet_id,
}: {
    wallet_type: (typeof WalletType.enumValues)[number];
    wallet_id: number;
}) => {
    switch (wallet_type) {
        case "developer":
            return await db.query.ProjectWalletAddress.findMany({
                where: eq(ProjectWalletAddress.project_wallet_id, wallet_id),
                columns: {
                    address_id: true,
                },
            }).then((res) => res.map(({ address_id }) => address_id));
        case "project":
            return await db.query.UserProjectWalletAddress.findMany({
                where: eq(
                    UserProjectWalletAddress.user_project_wallet_id,
                    wallet_id
                ),
                columns: {
                    address_id: true,
                },
            }).then((res) => res.map(({ address_id }) => address_id));
        case "user":
            return await db.query.UserWalletAddress.findMany({
                where: eq(UserWalletAddress.user_wallet_id, wallet_id),
                columns: {
                    address_id: true,
                },
            }).then((res) => res.map(({ address_id }) => address_id));
    }
};
