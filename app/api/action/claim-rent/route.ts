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
} from "@solana/web3.js";
// @ts-ignore
import * as multisig from "@sqds/multisig";

// GET Request - Fetch metadata for the rent collector action
export async function GET(request: Request) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // Possible values for the action parameter
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
        icon: "https://example.com/rent-icon.png",
        title: "Claim Rent from Squads Multisig",
        description: "Claim rent from executed or cancelled transactions in your Squads multisig.",
        label: "Claim Rent",
        links: {
            actions: [
                {
                    label: "Claim Rent",
                    href: `${url.origin}${url.pathname}?action=claim&multisigAddress={multisigAddress}`,
                    parameters: [
                        {
                            name: "multisigAddress",
                            label: "Multisig Address",
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
    const multisigAddress = url.searchParams.get("multisigAddress");

    console.log("POST request received. Action:", action);
    console.log("Multisig Address:", multisigAddress);

    if (!action || action !== "claim" || !multisigAddress) {
        console.error("Invalid parameters. Action:", action, "Multisig Address:", multisigAddress);
        return Response.json({ error: "Invalid parameters" }, {
            status: 400,
            headers: ACTIONS_CORS_HEADERS,
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
    const multisigPda = new PublicKey(multisigAddress);

    try {
        console.log("Fetching multisig info for address:", multisigAddress);

        const accountInfo = await connection.getAccountInfo(multisigPda);
        if (!accountInfo || !accountInfo.data) {
            console.error("Failed to fetch or invalid account info for multisig address:", multisigAddress);
            return Response.json({ error: "Failed to fetch multisig account info" }, {
                status: 400,
                headers: ACTIONS_CORS_HEADERS,
            });
        }
        console.log("Raw multisig account data (hex):", accountInfo.data.toString('hex'));

        const [multisigObj] = await multisig.accounts.Multisig.fromAccountInfo(accountInfo);
        console.log("Multisig info fetched successfully:", multisigObj);

        const rentCollector = multisigObj.rentCollector?.toString();
        console.log("Rent Collector:", rentCollector || "Not defined");

        if (!rentCollector) {
            console.error("Rent collector not enabled for this multisig:", multisigAddress);
            return Response.json({ error: "Rent collector not enabled for this multisig" }, {
                status: 400,
                headers: ACTIONS_CORS_HEADERS,
            });
        }

        // Step 1: Derive the transaction PDA using the current transaction index and multisig address
        const txIndex = multisigObj.transactionIndex.toNumber();
        const [transactionPda] = multisig.getTransactionPda({
            multisigPda,
            index: BigInt(txIndex),
        });

        console.log("Derived transaction PDA:", transactionPda.toString());

        // Step 2: Fetch the transaction account using the derived PDA
        const transactionAccountInfo = await connection.getAccountInfo(transactionPda);
        if (!transactionAccountInfo || !transactionAccountInfo.data) {
            console.error("Transaction account data is empty or invalid.");
            return Response.json({ error: "Transaction account data is empty or invalid" }, {
                status: 400,
                headers: ACTIONS_CORS_HEADERS,
            });
        }

        console.log("Transaction account data length:", transactionAccountInfo.data.length);
        console.log("Transaction account data (hex):", transactionAccountInfo.data.toString('hex'));

        // Verify the expected length before deserialization
        if (transactionAccountInfo.data.length < 116) {
            console.error("Transaction account data is shorter than expected, cannot proceed with deserialization.");
            return Response.json({ error: "Invalid transaction account data length" }, {
                status: 400,
                headers: ACTIONS_CORS_HEADERS,
            });
        }

        try {
            const transactionInfo = await multisig.accounts.VaultTransaction.fromAccountInfo(transactionAccountInfo);
            console.log("Transaction info fetched successfully:", transactionInfo);

            // Step 3: Fetch and validate the Proposal PDA using the derived transaction index
            console.log("Fetching proposal info for transaction index:", txIndex);
            const [proposalPda] = multisig.getProposalPda({
                multisigPda,
                transactionIndex: BigInt(txIndex),
            });

            console.log("Derived proposal PDA:", proposalPda.toString());

            const proposalInfo = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
            console.log("Proposal info fetched successfully:", proposalInfo);

            const status = proposalInfo.status.__kind;
            console.log("Proposal status:", status);

            if (status !== "Executed" && status !== "Cancelled") {
                console.error("Transaction is not in a state to claim rent. Status:", status);
                return Response.json({ error: "Transaction is not in a state to claim rent" }, {
                    status: 400,
                    headers: ACTIONS_CORS_HEADERS,
                });
            }

            console.log("Building transaction for closing accounts and claiming rent...");
            const transaction = new Transaction();
            transaction.add(
                await multisig.instructions.vaultTransactionAccountsClose({
                    multisigPda,
                    transactionIndex: BigInt(txIndex),
                    member: account,
                    rentCollector: new PublicKey(rentCollector),
                    programId: multisig.PROGRAM_ID,
                })
            );

            transaction.feePayer = account;
            transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

            console.log("Transaction built successfully:", transaction);

            const payload: ActionPostResponse = await createPostResponse({
                fields: {
                    transaction,
                    message: `Rent claim transaction created for transaction index ${txIndex}`,
                },
            });

            console.log("POST request processed successfully. Payload:", payload);

            return Response.json(payload, {
                headers: ACTIONS_CORS_HEADERS,
            });
        } catch (error) {
            console.error("Failed to deserialize transaction account data:", error);
            return Response.json({ error: "Invalid transaction account data" }, {
                status: 400,
                headers: ACTIONS_CORS_HEADERS,
            });
        }
    } catch (error: any) {
        console.error("Error during POST request processing:", error);
        return Response.json({ error: `Failed to process rent claim: ${error.message}` }, {
            status: 500,
            headers: ACTIONS_CORS_HEADERS,
        });
    }
}
