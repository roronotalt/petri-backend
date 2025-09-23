import {
    createDefaultRpcTransport,
    createSolanaRpcFromTransport,
    type RpcTransport,
} from "@solana/kit";

const helius_url = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const helius_devnet_url = `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

// List of RPC endpoints for failover.
const rpcEndpoints = [helius_url];
const rpcDevnetEndpoints = [helius_devnet_url];

// Create an array of transports from the endpoints.
const transports = rpcEndpoints.map((url) =>
    createDefaultRpcTransport({ url })
);
const devnetTransports = rpcDevnetEndpoints.map((url) =>
    createDefaultRpcTransport({ url })
);

// A failover transport that switches to the next transport on failure.
async function failoverTransport<TResponse>(
    ...args: Parameters<RpcTransport>
): Promise<TResponse> {
    let lastError;
    for (const transport of transports) {
        try {
            return await transport(...args);
        } catch (err) {
            lastError = err;
            console.warn(`Transport failed: ${err}. Trying next transport...`);
        }
    }
    // If all transports fail, throw the last error.
    throw lastError;
}

async function failoverTransportDevnet<TResponse>(
    ...args: Parameters<RpcTransport>
): Promise<TResponse> {
    let lastError;
    for (const transport of devnetTransports) {
        try {
            return await transport(...args);
        } catch (err) {
            lastError = err;
            console.warn(`Transport failed: ${err}. Trying next transport...`);
        }
    }
    throw lastError;
}

// Create the RPC client using the failover transport.
export const solanaRPC = createSolanaRpcFromTransport(failoverTransport);
export const solanaDevnetRPC = createSolanaRpcFromTransport(
    failoverTransportDevnet
);
