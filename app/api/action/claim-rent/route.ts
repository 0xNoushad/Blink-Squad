import {
    ACTIONS_CORS_HEADERS,
    ActionGetResponse,
    ActionPostRequest,
    ActionPostResponse,
    createPostResponse,
} from "@solana/actions";

import {
    Connection,
    PublicKey,
    Transaction,
    LAMPORTS_PER_SOL,
    AccountInfo,
} from "@solana/web3.js";
// @ts-ignore
import * as multisig from "@sqds/multisig";

const PROGRAM_ID = multisig.PROGRAM_ID;

// Optimized function to fetch multisig addresses
async function fetchMultisigAddresses(connection: Connection, userKey: PublicKey): Promise<PublicKey[]> {
    console.log("Fetching multisig addresses for user:", userKey.toString());

    const baseSize =
        8 + // anchor account discriminator
        32 + // create_key
        32 + // config_authority
        2 + // threshold
        4 + // time_lock
        8 + // transaction_index
        8 + // stale_transaction_index
        1 + // rent_collector Option discriminator
        32 + // rent_collector (always 32 bytes, even if None, just to keep the realloc logic simpler)
        1 + // bump
        4; // members vector length

    const maxMemberIndex = 10; // Reduce the number of attempts
    const batchSize = 3; // Number of parallel requests

    const fetchBatch = async (startIndex: number, endIndex: number) => {
        const filters = Array.from({ length: endIndex - startIndex }, (_, i) => ({
            memcmp: {
                offset: baseSize + (startIndex + i) * 33,
                bytes: userKey.toBase58(),
            },
        }));

        try {
            const results = await Promise.all(
                filters.map(filter =>
                    connection.getProgramAccounts(PROGRAM_ID, { filters: [filter] })
                )
            );
            return results.flatMap(result => result.map(account => account.pubkey));
        } catch (e) {
            console.error(`Error fetching multisigs for indices ${startIndex}-${endIndex}:`, e);
            return [];
        }
    };

    let multisigAddresses: PublicKey[] = [];

    for (let i = 0; i < maxMemberIndex; i += batchSize) {
        const endIndex = Math.min(i + batchSize, maxMemberIndex);
        const batchResults = await fetchBatch(i, endIndex);
        multisigAddresses.push(...batchResults);

        if (multisigAddresses.length > 0) {
            break; // Exit early if we found any addresses
        }
    }

    console.log("Fetched multisig addresses:", multisigAddresses.map(addr => addr.toString()));
    return multisigAddresses;
}

// GET Request - Fetch metadata for the rent collector action
export async function GET(request: Request) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    const validActions = ["claim"];
    console.log("GET request received. Action:", action);

    if (!action || !validActions.includes(action)) {
        console.error("Invalid or missing action parameter:", action);
        return Response.json({ error: "Invalid or missing parameters" }, {
            status: 400,
            headers: ACTIONS_CORS_HEADERS,
        });
    }

    const payload: ActionGetResponse = {
        icon: "https://i.imgur.com/DIb21T3.png",
        title: "Claim Rent from Squads Multisig",
        description: "Claim rent from executed or cancelled transactions in your Squads multisig. Click and Connect wallet to claim.",
        label: "Claim Rent",
        links: {
            actions: [
                {
                    label: "Claim Rent",
                    href: `${url.origin}${url.pathname}?action=claim`,
                },
            ],
        },
    };

    console.log("GET request processed successfully. Payload:", payload);
    return Response.json(payload, {
        headers: ACTIONS_CORS_HEADERS,
    });
}

export const OPTIONS = GET;

// POST Request - Execute the rent collection transaction
export async function POST(request: Request) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    console.log("POST request received. Action:", action);

    if (!action || action !== "claim") {
        console.error("Invalid action parameter:", action);
        return Response.json({ error: "Invalid parameters" }, {
            status: 400,
            headers: ACTIONS_CORS_HEADERS,
            statusText: "Invalid parameters",
        });
    }

    const body: ActionPostRequest = await request.json();

    let account: PublicKey;
    try {
        account = new PublicKey(body.account);
        console.log("User account parsed successfully:", account.toString());
    } catch (error) {
        console.error("Invalid user account provided:", body.account);
        return Response.json({ error: "Invalid account" }, {
            status: 400,
            headers: ACTIONS_CORS_HEADERS,
        });
    }

    // console.log("RPC URL:", process.env.NEXT_PUBLIC_RPC_URL);
    const connection = new Connection(process.env.NEXT_PUBLIC_RPC_URL!, "confirmed");

    try {
        // Fetch multisig addresses
        // Fetch multisig addresses using the optimized function
        console.log("Fetching multisig addresses...");
        const multisigAddresses = await fetchMultisigAddresses(connection, account);

        if (multisigAddresses.length === 0) {
            console.log("No multisig addresses found for the user.");
            return Response.json({ error: "No multisig addresses found for the user" }, {
                status: 400,
                headers: ACTIONS_CORS_HEADERS,
                statusText: "No multisig addresses found",
            });
        }

        // Create a single transaction to bundle all instructions
        const transaction = new Transaction();
        let totalTransactionsProcessed = 0;
        let totalRentCollected = 0;

        // Process each multisig in parallel
        await Promise.all(multisigAddresses.map(async (multisigPda) => {
            console.log("Fetching multisig info for address:", multisigPda.toString());

            const multisigObj = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
            console.log("Multisig info fetched successfully:", multisigObj);

            const rentCollector = multisigObj.rentCollector?.toString();
            console.log("Rent Collector:", rentCollector || "Not defined");

            if (!rentCollector) {
                console.log(`Skipping multisig ${multisigPda.toString()} as rent collector is not enabled.`);
                return; // Skip this multisig if rent collector is not enabled
            }

            // Iterate through each transaction from staleTransactionIndex to transactionIndex
            for (let txIndex = multisigObj.staleTransactionIndex; txIndex <= multisigObj.transactionIndex; txIndex++) {
                const [transactionPda] = multisig.getTransactionPda({
                    multisigPda,
                    index: txIndex,
                });

                console.log("Derived transaction PDA:", transactionPda.toString());

                let transactionInfo;
                let isVaultTransaction = false;

                try {
                    transactionInfo = await multisig.accounts.VaultTransaction.fromAccountAddress(connection, transactionPda);
                    isVaultTransaction = true;
                    console.log("Transaction deserialized as VaultTransaction successfully:", transactionInfo);
                } catch (error) {
                    console.error("Failed to deserialize as Vault Transaction:");
                    continue; // Skip this transaction if it's not a Vault Transaction
                }

                const [proposalPda] = multisig.getProposalPda({
                    multisigPda,
                    transactionIndex: txIndex,
                });

                console.log("Derived proposal PDA:", proposalPda.toString());

                const proposalInfo = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
                console.log("Proposal info fetched successfully:", proposalInfo);

                const status = proposalInfo.status.__kind;
                console.log("Proposal status:", status);

                if (status === "Executed" || status === "Cancelled" || status === "Rejected") {
                    console.log("Adding instructions for closing accounts and claiming rent...");
                    transaction.add(
                        await multisig.instructions.vaultTransactionAccountsClose({
                            multisigPda,
                            transactionIndex: txIndex,
                            member: account,
                            rentCollector: new PublicKey(rentCollector),
                            programId: multisig.PROGRAM_ID,
                        })
                    );
                    totalTransactionsProcessed++;
                    totalRentCollected += transactionInfo.rent; // Assume 'rent' is the rent amount in lamports
                }
            }
        }));

        if (totalTransactionsProcessed === 0) {
            console.log("No Vault transactions found to claim rent.");
            return Response.json({ error: "No Transactions to claim rent from" }, {
                status: 400,
                headers: ACTIONS_CORS_HEADERS,
                statusText: "No Transactions to claim rent from",
            });
        }

        const blockheight = await connection.getLatestBlockhash();
        transaction.feePayer = account;
        transaction.recentBlockhash = blockheight.blockhash;
        transaction.lastValidBlockHeight = blockheight.lastValidBlockHeight;

        const totalRentInSol = totalRentCollected / LAMPORTS_PER_SOL;

        const payload: ActionPostResponse = await createPostResponse({
            fields: {
                transaction,
                message: `Rent claim transaction created for ${totalTransactionsProcessed} Vault transactions across ${multisigAddresses.length} multisigs. Total rent collected: ${totalRentInSol.toFixed(4)} SOL.`,
            },
        });

        console.log("POST request processed successfully. Payload:", payload);

        return Response.json(payload, {
            headers: ACTIONS_CORS_HEADERS,
        });
    } catch (error: any) {
        console.error("Error during POST request processing:", error);
        return Response.json({ error: `Failed to process rent claim: ${error.message}` }, {
            status: 500,
            headers: ACTIONS_CORS_HEADERS,
        });
    }
}