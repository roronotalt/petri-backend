import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../index";
import { Transaction } from "../../schema";
import * as Sentry from "@sentry/node";

export const generateTxHash = async (): Promise<string> => {
    const txHash = randomBytes(256).toString("hex");
    const txHashExists = await db
        .select()
        .from(Transaction)
        .where(eq(Transaction.hash, txHash));
    if (txHashExists.length > 0) {
        Sentry.captureException("Kasssandra tx hash collision occurred", {
            level: "fatal",
            extra: {
                txHash,
            },
        });
        return generateTxHash();
    }
    return txHash;
};
