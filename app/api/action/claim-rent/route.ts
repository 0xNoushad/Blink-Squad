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
    clusterApiUrl,
} from "@solana/web3.js";
// @ts-ignore
import * as multisig from "@sqds/multisig";

// GET Request - Fetch metadata for the rent collector action
export async function GET(request: Request) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // Possible values for the action parameter
    const validActions = ["claim"];

    if (!action || !validActions.includes(action)) {
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
                    href: `${url.origin}${url.pathname}?action=claim&multisigAddress={multisigAddress}&transactionAccount={transactionAccount}`,
                    parameters: [
                        {
                            name: "multisigAddress",
                            label: "Multisig Address",
                            required: true,
                        },
                        {
                            name: "transactionAccount",
                            label: "Transaction Account",
                            required: true,
                        },
                    ],
                },
            ],
        },
    };

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
    const transactionAccount = url.searchParams.get("transactionAccount");

    if (!action || action !== "claim" || !multisigAddress || !transactionAccount) {
        return Response.json({ error: "Invalid parameters" }, {
            status: 400,
            headers: ACTIONS_CORS_HEADERS,
        });
    }

    const body: ActionPostRequest = await request.json();

    let account: PublicKey;
    try {
        account = new PublicKey(body.account);
    } catch (error) {
        return Response.json({ error: "Invalid account" }, {
            status: 400,
            headers: ACTIONS_CORS_HEADERS,
        });
    }

    const connection = new Connection(process.env.NEXT_PUBLIC_RPC_URL!, "confirmed");
    const multisigPda = new PublicKey(multisigAddress);

    try {
        // Step 1: Check if the multisig has a rentCollector enabled
        const multisigInfo = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
        const rentCollector = multisigInfo.rentCollector;

        if (!rentCollector) {
            return Response.json({ error: "Rent collector not enabled for this multisig" }, {
                status: 400,
                headers: ACTIONS_CORS_HEADERS,
            });
        }

        // Step 2: Fetch & deserialize the transaction account
        const transactionPubkey = new PublicKey(transactionAccount);
        const transactionInfo = await multisig.accounts.VaultTransaction.fromAccountAddress(
            connection,
            transactionPubkey
        );

        // Step 3: Get its transactionIndex
        const txIndex = transactionInfo.transactionIndex;

        // Step 4: Use the index to fetch the Proposal
        const [proposalPda] = multisig.getProposalPda({
            multisigPda,
            transactionIndex: txIndex,
        });

        const proposalInfo = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);

        // Step 5: Check the proposal's status
        const status = proposalInfo.status.__kind;

        if (status !== "Executed" && status !== "Cancelled") {
            return Response.json({ error: "Transaction is not in a state to claim rent" }, {
                status: 400,
                headers: ACTIONS_CORS_HEADERS,
            });
        }

        // Step 6: Build the vaultTransactionAccountsClose instruction
        const transaction = new Transaction();
        transaction.add(
            await multisig.instructions.vaultTransactionAccountsClose({
                multisigPda,
                transactionIndex: txIndex,
                member: account,
                rentCollector,
                programId: multisig.PROGRAM_ID,
            })
        );

        transaction.feePayer = account;
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        const payload: ActionPostResponse = await createPostResponse({
            fields: {
                transaction,
                message: `Rent claim transaction created for transaction index ${txIndex}`,
            },
        });

        return Response.json(payload, {
            headers: ACTIONS_CORS_HEADERS,
        });

    } catch (error) {
        console.error("Error:", error);
        return Response.json({ error: "Failed to process rent claim" }, {
            status: 500,
            headers: ACTIONS_CORS_HEADERS,
        });
    }
}
