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
        icon: "https://i.imgur.com/qmLuFpz.png",
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

        const multisigObj = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
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

        // Derive the transaction PDA using the current transaction index and multisig address
        const txIndex = multisigObj.transactionIndex;
        const [transactionPda] = multisig.getTransactionPda({
            multisigPda,
            index: txIndex,
        });

        console.log("Derived transaction PDA:", transactionPda.toString());

        // Try to deserialize as VaultTransaction first
        let transactionInfo;
        let isVaultTransaction = false;

        try {
            transactionInfo = await multisig.accounts.VaultTransaction.fromAccountAddress(connection, transactionPda);
            isVaultTransaction = true;
            console.log("Transaction deserialized as VaultTransaction successfully:", transactionInfo);
        } catch (error) {
            console.error("Failed to deserialize as Vault Transaction:", error);
        }

        if (!isVaultTransaction) {
            try {
                transactionInfo = await multisig.accounts.ConfigTransaction.fromAccountAddress(connection, transactionPda);
                console.log("Transaction deserialized as ConfigTransaction successfully:", transactionInfo);
            } catch (error) {
                console.error("Failed to deserialize as Config Transaction:", error);
                return Response.json({ error: "Failed to deserialize transaction" }, {
                    status: 400,
                    headers: ACTIONS_CORS_HEADERS,
                });
            }
        }

        // Fetch and validate the Proposal PDA using the derived transaction index
        console.log("Fetching proposal info for transaction index:", txIndex.toString());
        const [proposalPda] = multisig.getProposalPda({
            multisigPda,
            transactionIndex: txIndex,
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
                transactionIndex: txIndex,
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
                message: `Rent claim transaction created for transaction index ${txIndex.toString()}`,
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
