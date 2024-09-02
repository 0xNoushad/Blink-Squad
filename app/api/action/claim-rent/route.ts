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
} from "@solana/web3.js";
// @ts-ignore
import * as multisig from "@sqds/multisig";

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
        description: "Claim rent from executed or cancelled transactions in your Squads multisig. Enter Multisig Addresses Comma-separated (max 3).",
        label: "Claim Rent",
        links: {
            actions: [
                {
                    label: "Claim Rent",
                    href: `${url.origin}${url.pathname}?action=claim&multisigAddresses={multisigAddresses}`,
                    parameters: [
                        {
                            name: "multisigAddresses",
                            label: "Multisig Addresses (comma-separated, max 3)",
                            required: true,
                        },
                    ],
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
    const multisigAddressesParam = url.searchParams.get("multisigAddresses");

    console.log("POST request received. Action:", action);
    console.log("Multisig Addresses:", multisigAddressesParam);

    if (!action || action !== "claim" || !multisigAddressesParam) {
        console.error("Invalid parameters. Action:", action, "Multisig Addresses:", multisigAddressesParam);
        return Response.json({ error: "Invalid parameters" }, {
            status: 400,
            headers: ACTIONS_CORS_HEADERS,
            statusText: "Invalid parameters",
        });
    }

    const multisigAddresses = multisigAddressesParam.split(',');

    if (multisigAddresses.length > 3) {
        console.error("More than 3 multisig addresses provided.");
        return Response.json({ error: "Please provide up to 3 multisig addresses only." }, {
            status: 400,
            headers: ACTIONS_CORS_HEADERS,
            statusText: "Too many multisig addresses",
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

    console.log("RPC URL:", process.env.NEXT_PUBLIC_RPC_URL);
    const connection = new Connection(process.env.NEXT_PUBLIC_RPC_URL!, "confirmed");

    try {
        // Create a single transaction to bundle all instructions
        const transaction = new Transaction();
        let totalTransactionsProcessed = 0;
        let totalRentCollected = 0;

        // Process each multisig in parallel
        await Promise.all(multisigAddresses.map(async (multisigAddress) => {
            const multisigPda = new PublicKey(multisigAddress);
            console.log("Fetching multisig info for address:", multisigAddress);

            const multisigObj = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
            console.log("Multisig info fetched successfully:", multisigObj);

            const rentCollector = multisigObj.rentCollector?.toString();
            console.log("Rent Collector:", rentCollector || "Not defined");

            if (!rentCollector) {
                console.log(`Skipping multisig ${multisigAddress} as rent collector is not enabled.`);
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
                    console.error("Failed to deserialize as Vault Transaction:", error);
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
