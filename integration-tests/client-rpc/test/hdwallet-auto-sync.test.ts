import "mocha";
import chaiAsPromised = require("chai-as-promised");
import { use as chaiUse, expect } from "chai";
import BigNumber from "bignumber.js";

import { RpcClient } from "./core/rpc-client";
import { unbondAndWithdrawStake } from "./core/setup";
import {
	newWalletRequest,
    newCreateWalletRequest,
	generateWalletName,
	newZeroFeeRpcClient,
	sleep,
	shouldTest,
	FEE_SCHEMA,
	asyncMiddleman,
	newZeroFeeTendermintClient,
	TRANSACTION_HISTORY_LIMIT,
    DEFAULT_PASSPHRASE,
} from "./core/utils";
import { syncWallet, waitTxIdConfirmed } from "./core/rpc";
import { TendermintClient } from "./core/tendermint-client";
import {
	getFirstElementOfArray,
	expectTransactionShouldBe,
	TransactionDirection,
} from "./core/transaction-utils";
chaiUse(chaiAsPromised);

describe("HDWallet Auto-sync", () => {
	let zeroFeeRpcClient: RpcClient;
	let zeroFeeTendermintClient: TendermintClient;
	before(async () => {
		await unbondAndWithdrawStake();
		zeroFeeRpcClient = newZeroFeeRpcClient();
		zeroFeeTendermintClient = newZeroFeeTendermintClient();
	});

	if (!shouldTest(FEE_SCHEMA.ZERO_FEE)) {
		return;
	}

	it("can auto-sync unlocked wallets", async function () {
		this.timeout(300000);

		const receiverWalletName = generateWalletName("Receive");
		const senderWalletRequest = await newWalletRequest(zeroFeeRpcClient, "Default", DEFAULT_PASSPHRASE);
		const receiverCreateWalletRequest = newCreateWalletRequest(receiverWalletName, DEFAULT_PASSPHRASE);
		const transferAmount = "1000";

		let enckey = (await asyncMiddleman(
			zeroFeeRpcClient.request("wallet_create", [receiverCreateWalletRequest, "HD"]),
			"Error when creating receiver wallet",
		))[0];
        let receiverWalletRequest = {
            name: receiverWalletName,
            enckey
        };

		await asyncMiddleman(
			syncWallet(zeroFeeRpcClient, senderWalletRequest),
			"Error when synchronizing sender wallet",
		);
		await asyncMiddleman(
			syncWallet(zeroFeeRpcClient, receiverWalletRequest),
			"Error when synchronizing receiver wallet",
		);

		const senderWalletTransactionListBeforeSend = await asyncMiddleman(
			zeroFeeRpcClient.request("wallet_transactions", [senderWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
			"Error when retrieving sender wallet transactions before send",
		);
		const senderWalletBalanceBeforeSend = await asyncMiddleman(
			zeroFeeRpcClient.request("wallet_balance", [senderWalletRequest]),
			"Error when retrieving sender wallet balance before send",
		);

		const receiverWalletTransferAddress = await asyncMiddleman(
			zeroFeeRpcClient.request("wallet_createTransferAddress", [
				receiverWalletRequest,
			]),
			"Error when creating receiver wallet transfer address",
		);
		const receiverWalletTransactionListBeforeReceive = await asyncMiddleman(
			zeroFeeRpcClient.request("wallet_transactions", [receiverWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
			"Error when retrieving receiver wallet transactions before receive",
		);
		const receiverWalletBalanceBeforeReceive = await asyncMiddleman(
			zeroFeeRpcClient.request("wallet_balance", [receiverWalletRequest]),
			"Error when retrieving receiver wallet balance before receive",
		);
		const receiverViewKey = await asyncMiddleman(
			zeroFeeRpcClient.request("wallet_getViewKey", [receiverWalletRequest, false]),
			"Error when retrieving receiver view key",
		);

		const txId = await asyncMiddleman(
			zeroFeeRpcClient.request("wallet_sendToAddress", [
				senderWalletRequest,
				receiverWalletTransferAddress,
				transferAmount,
				[receiverViewKey],
			]),
			"Error when sending funds from sender to receiver",
		);
		expect(txId.length).to.eq(
			64,
			"wallet_sendToAddress should return transaction id",
		);

		await asyncMiddleman(
			waitTxIdConfirmed(zeroFeeTendermintClient, txId),
			"Error when waiting transfer transaction confirmation",
		);

		await zeroFeeRpcClient.request("sync_unlockWallet", [senderWalletRequest]);
		await zeroFeeRpcClient.request("sync_unlockWallet", [receiverWalletRequest]);
		console.info(
			`[Log] Enabled auto-sync for wallets "${senderWalletRequest.name}" and "${receiverWalletName}"`,
		);

		await sleep(1000);
		while (true) {
			console.log(`[Log] Checking for wallet sync status`);
			const senderWalletTransactionListAfterSend = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_transactions", [senderWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
				"Error when retrieving sender wallet transactions after send",
			);

			const receiverWalletTransactionListAfterReceive = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_transactions", [receiverWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
				"Error when retrieving receiver wallet transactions after send",
			);

			if (
				senderWalletTransactionListAfterSend.length ===
				senderWalletTransactionListBeforeSend.length + 1 &&
				receiverWalletTransactionListAfterReceive.length ===
				receiverWalletTransactionListBeforeReceive.length + 1
			) {
				console.log(`[Log] Auto-sync caught up with latest transactions`);
				break;
			}
			await sleep(1000);
		}

		const senderWalletTransactionListAfterSend = await asyncMiddleman(
			zeroFeeRpcClient.request("wallet_transactions", [senderWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
			"Error when retrieving sender wallet transactions after send",
		);

		expect(senderWalletTransactionListAfterSend.length).to.eq(
			senderWalletTransactionListBeforeSend.length + 1,
			"Sender should have one extra transaction record",
		);
		const senderWalletLastTransaction = getFirstElementOfArray(
			senderWalletTransactionListAfterSend,
		);

		expectTransactionShouldBe(
			senderWalletLastTransaction,
			{
				direction: TransactionDirection.OUTGOING,
				amount: new BigNumber(transferAmount),
			},
			"Sender should have one Outgoing transaction",
		);

		const senderWalletBalanceAfterSync = await asyncMiddleman(
			zeroFeeRpcClient.request("wallet_balance", [senderWalletRequest]),
			"Error when retrieving sender wallet balance after send",
		);
		// after sync, the sender's pending balance will become available
		const returnAmount = new BigNumber(senderWalletBalanceBeforeSend.total)
			.minus(transferAmount)
			.toString(10);
		const expectedBalanceAfterSync = {
			total: returnAmount,
			pending: "0",
			available: returnAmount,
		};
		expect(senderWalletBalanceAfterSync).to.deep.eq(
			expectedBalanceAfterSync,
			"Sender balance should be deducted by transfer amount",
		);

		const receiverWalletTransactionListAfterReceive = await asyncMiddleman(
			zeroFeeRpcClient.request("wallet_transactions", [receiverWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
			"Error when retrieving receiver wallet transactions after receive",
		);
		expect(receiverWalletTransactionListAfterReceive.length).to.eq(
			receiverWalletTransactionListBeforeReceive.length + 1,
			"Receiver should have one extra transaction record",
		);

		const receiverWalletLastTransaction = getFirstElementOfArray(
			receiverWalletTransactionListAfterReceive,
		);
		expectTransactionShouldBe(
			receiverWalletLastTransaction,
			{
				direction: TransactionDirection.INCOMING,
				amount: new BigNumber(transferAmount),
			},
			"Receiver should have one Incoming transaction of the received amount",
		);

		const receiverWalletBalanceAfterReceive = await asyncMiddleman(
			zeroFeeRpcClient.request("wallet_balance", [receiverWalletRequest]),
			"Error when retrieving receiver wallet balance after receive",
		);
		const receiverTotalAmount = new BigNumber(receiverWalletBalanceBeforeReceive.total)
			.plus(transferAmount)
			.toString(10);
		const expectedBalanceAfterReceive = {
			total: receiverTotalAmount,
			available: receiverTotalAmount,
			pending: "0",
		};
		expect(receiverWalletBalanceAfterReceive).to.deep.eq(
			expectedBalanceAfterReceive,
			"Receiver balance should be increased by transfer amount",
		);
	});
});
