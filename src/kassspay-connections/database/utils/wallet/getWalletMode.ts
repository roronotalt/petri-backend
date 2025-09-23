import { db } from "../../index";
import { ProjectWallet, UserProjectWallet, WalletType } from "../../schema";
import { eq } from "drizzle-orm";

// get if the wallet is in prod or dev mode
export const getWalletMode = async ({
    wallet_type,
    wallet_id,
}: {
    wallet_type: (typeof WalletType.enumValues)[number];
    wallet_id: number;
}) => {
    switch (wallet_type) {
        case "developer":
            return await db.query.ProjectWallet.findFirst({
                where: eq(ProjectWallet.id, wallet_id),
                with: {
                    project: {
                        columns: {
                            production_mode: true,
                        },
                    },
                },
            }).then((res) => res?.project.production_mode);
        case "project":
            return await db.query.UserProjectWallet.findFirst({
                where: eq(UserProjectWallet.id, wallet_id),
                with: {
                    project: {
                        columns: {
                            production_mode: true,
                        },
                    },
                },
            }).then((res) => res?.project.production_mode);
        case "user":
            return true;
    }
};
